import express from 'express';
import { z } from 'zod';
import { verifyHmac, signHmac } from './crypto';
import axios from 'axios';
import * as tar from 'tar';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { countRepositoryLOC, validateSyntax } from './ast';
import { getScanner, RESCAN_CHECK } from './scanners';
import { applyEditsToTree } from './edits';
import { runExecValidate } from './exec-validate';
import { BaselineCache } from './baseline-cache';
const app = express();
app.use(express.json({ limit: '1mb' }));

const RUNNER_HMAC_SECRET = process.env.RUNNER_HMAC_SECRET;
const RUNNER_CALLBACK_SECRET = process.env.RUNNER_CALLBACK_SECRET;
const RUNNER_CALLBACK_URL = process.env.RUNNER_CALLBACK_URL || 'http://localhost:3000/api/runner/callback';

if (!RUNNER_HMAC_SECRET || !RUNNER_CALLBACK_SECRET) {
    console.error("Missing required environment variables RUNNER_HMAC_SECRET or RUNNER_CALLBACK_SECRET");
    process.exit(1);
}

async function deliverCallback(resultPayload: Record<string, unknown>) {
    resultPayload.timestamp = Date.now();
    const callbackPayload = JSON.stringify(resultPayload);
    const callbackSignature = signHmac(callbackPayload, RUNNER_CALLBACK_SECRET!);

    try {
        await axios.post(RUNNER_CALLBACK_URL, resultPayload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Runner-Callback-Signature': callbackSignature
            }
        });
    } catch (e: unknown) {
        console.error("Failed to deliver callback", e);
    }
}

async function downloadAndExtract(url: string, extractDir: string) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream'
    });

    let totalBytes = 0;
    let fileCount = 0;
    const MAX_BYTES = 500 * 1024 * 1024; // 500MB
    const MAX_FILES = 10000;

    return new Promise<void>((resolve, reject) => {
        response.data.pipe(tar.x({
            cwd: extractDir,
            strip: 1,
            filter: (tarPath, stat) => {
                fileCount++;
                totalBytes += stat.size;

                if (fileCount > MAX_FILES) throw new Error("Excessive file count in tarball");
                if (totalBytes > MAX_BYTES) throw new Error("Excessive total expanded bytes in tarball");

                if (path.isAbsolute(tarPath)) return false;
                if (tarPath.includes('..')) return false;
                if ('type' in stat) {
                    if (stat.type === 'SymbolicLink' || stat.type === 'BlockDevice' || stat.type === 'CharacterDevice' || stat.type === 'FIFO') {
                        return false;
                    }
                } else if (typeof stat.isSymbolicLink === 'function') {
                    if (stat.isSymbolicLink() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
                        return false;
                    }
                }
                return true;
            }
        }))
        .on('finish', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
}

const baselineCache = new BaselineCache();

const JobRequestSchema = z.object({
    type: z.enum(['SCAN', 'STATIC_VALIDATE', 'EXEC_VALIDATE']),
    // Which scanner to run for SCAN and for the re-scan in STATIC_VALIDATE
    tool: z.string().max(40).optional(),
    // EXEC_VALIDATE: identifies the unmodified tree, so fixes for the same commit share one baseline run
    baselineKey: z.string().min(1).max(200).optional(),
    scanRunId: z.string().optional(),
    validationRunId: z.string().optional(),
    tarballUrl: z.string().url(),
    changedFiles: z.array(z.string()).max(1000).optional(),
    edits: z.array(z.object({
        path: z.string(),
        find: z.string(),
        replace: z.string()
    })).optional(),
    timestamp: z.number()
});

app.post('/v1/jobs', async (req, res) => {
    const signature = req.headers['x-runner-signature'];
    if (typeof signature !== 'string') return res.status(401).json({ error: "Missing signature" });

    const payloadString = JSON.stringify(req.body);
    if (!verifyHmac(payloadString, signature, RUNNER_HMAC_SECRET!)) {
        return res.status(401).json({ error: "Invalid signature" });
    }

    const parsed = JobRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error });
    }

    const { type, tool, baselineKey, scanRunId, validationRunId, tarballUrl, edits, changedFiles, timestamp } = parsed.data;

    if (Date.now() - timestamp > 5 * 60 * 1000) {
        return res.status(401).json({ error: "Request expired" });
    }

    res.status(202).json({ status: "Accepted" });

    if (type === 'SCAN') {
        const workDir = path.join(os.tmpdir(), `scan-${scanRunId}-${Date.now()}`);
        const resultPayload: Record<string, unknown> = { scanRunId, tool, status: "COMPLETED" };
        const scanner = tool ? getScanner(tool) : undefined;

        try {
            if (!scanner) {
                // Fail closed: a scanner this runner does not have is a failed scan, not an empty one.
                resultPayload.status = "FAILED";
                resultPayload.errorCode = "SCAN_TOOL_UNSUPPORTED";
                resultPayload.error = `SCAN_TOOL_UNSUPPORTED: this runner has no scanner "${tool ?? ''}"`;
            } else {
                fs.mkdirSync(workDir, { recursive: true });
                await downloadAndExtract(tarballUrl, workDir);

                // Fail closed: only a fully trustworthy scan is reported as COMPLETED.
                const outcome = await scanner.scan(workDir, { files: changedFiles });
                if (outcome.ok) {
                    resultPayload.toolResult = outcome.result;
                    resultPayload.repoLOC = countRepositoryLOC(workDir);
                } else {
                    resultPayload.status = "FAILED";
                    resultPayload.errorCode = outcome.code;
                    resultPayload.error = `${outcome.code}: ${outcome.error}`;
                }
            }
        } catch (err: any) {
            resultPayload.status = "FAILED";
            resultPayload.errorCode = "SCAN_SOURCE_UNAVAILABLE";
            resultPayload.error = `SCAN_SOURCE_UNAVAILABLE: ${err.message || "Extraction or download error"}`;
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true });
        }

        await deliverCallback(resultPayload);
    } else if (type === 'STATIC_VALIDATE') {
        const workDir = path.join(os.tmpdir(), `validate-${validationRunId}-${Date.now()}`);
        const checkResults: Record<string, string> = {};
        const resultPayload: Record<string, unknown> = { validationRunId, tool, status: "COMPLETED", checkResults };
        const scanner = tool ? getScanner(tool) : undefined;

        try {
            if (!scanner) throw new Error(`SCAN_TOOL_UNSUPPORTED: this runner has no scanner "${tool ?? ''}"`);
            fs.mkdirSync(workDir, { recursive: true });
            await downloadAndExtract(tarballUrl, workDir);

            let patchApplySuccess = false;
            try {
                patchApplySuccess = applyEditsToTree(workDir, edits);
            } catch {
                patchApplySuccess = false;
            }
            checkResults.PATCH_APPLY = patchApplySuccess ? "PASSED" : "FAILED";

            if (patchApplySuccess) {
                // Syntax Validation using native AST parser
                let syntaxSuccess = true;
                for (const edit of edits || []) {
                    if (!validateSyntax(path.join(workDir, edit.path))) {
                        syntaxSuccess = false;
                        break;
                    }
                }
                checkResults.SYNTAX = syntaxSuccess ? "PASSED" : "FAILED";

                if (syntaxSuccess) {
                    // Only re-scan if syntax passes. A rescan that did not complete is FAILED, never PASSED.
                    // The file the issue is in plus the files this fix edits. A scanner that works
                    // per file must look at both, or a fix made elsewhere would seem to remove the issue.
                    const files = Array.from(new Set([...(changedFiles || []), ...(edits || []).map(e => e.path)]));
                    const outcome = await scanner.scan(workDir, { files });
                    if (outcome.ok) {
                        resultPayload.toolResult = outcome.result;
                        checkResults[RESCAN_CHECK] = "PASSED";
                    } else {
                        checkResults[RESCAN_CHECK] = "FAILED";
                        resultPayload.status = "FAILED";
                        resultPayload.errorCode = outcome.code;
                        resultPayload.error = `${outcome.code}: ${outcome.error}`;
                    }
                } else {
                    checkResults[RESCAN_CHECK] = "FAILED"; // Aborted
                }
            }
        } catch (err: any) {
            resultPayload.status = "FAILED";
            resultPayload.error = err.message || "Extraction or download error";
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true });
        }

        await deliverCallback(resultPayload);
    } else if (type === 'EXEC_VALIDATE') {
        const baseWorkDir = path.join(os.tmpdir(), `exec-validate-${validationRunId}-${Date.now()}`);
        const baselineDir = path.join(baseWorkDir, 'baseline');
        const fixedDir = path.join(baseWorkDir, 'fixed');
        const resultPayload: Record<string, unknown> = { validationRunId, status: "COMPLETED", checkResults: {} };

        try {
            fs.mkdirSync(baselineDir, { recursive: true });
            fs.mkdirSync(fixedDir, { recursive: true });

            // 1. Prepare baseline tree
            await downloadAndExtract(tarballUrl, baselineDir);

            // 2. Prepare fixed tree: a copy of the baseline (one download), then the edits
            fs.cpSync(baselineDir, fixedDir, { recursive: true });

            if (!applyEditsToTree(fixedDir, edits)) {
                resultPayload.status = "FAILED";
                resultPayload.error = "Failed to apply patch to fixed tree";
            } else {
                // 3. Execute Baseline. Every fix for the same commit has the same baseline, so it runs once.
                const baselineResult = await baselineCache.get(baselineKey, baselineDir, () => runExecValidate(baselineDir));

                if (baselineResult.notApplicable) {
                    // The repository has nothing to run. Reported as such; the app decides what that means.
                    resultPayload.execResults = {
                        provider: baselineResult.provider,
                        notApplicable: baselineResult.notApplicable
                    };
                } else if (baselineResult.error) {
                    resultPayload.status = "FAILED";
                    resultPayload.error = "Baseline: " + baselineResult.error;
                } else {
                    // 4. Execute Fixed
                    const fixedResult = await runExecValidate(fixedDir);

                    if (fixedResult.notApplicable) {
                        // Runnable before the fix, not runnable after it: the fix broke the project setup.
                        resultPayload.status = "FAILED";
                        resultPayload.error = `Fixed: the change left nothing runnable (${fixedResult.notApplicable.code}: ${fixedResult.notApplicable.detail})`;
                    } else if (fixedResult.error) {
                        resultPayload.status = "FAILED";
                        resultPayload.error = "Fixed: " + fixedResult.error;
                    } else {
                        // Compare and structure response
                        resultPayload.execResults = {
                            provider: fixedResult.provider,
                            baselineSandboxId: baselineResult.sandboxId,
                            fixedSandboxId: fixedResult.sandboxId,
                            baseline: baselineResult.results,
                            fixed: fixedResult.results
                        };
                    }
                }
            }
        } catch (err: any) {
            resultPayload.status = "FAILED";
            resultPayload.error = err.message || "Extraction or download error";
        } finally {
            fs.rmSync(baseWorkDir, { recursive: true, force: true });
        }

        await deliverCallback(resultPayload);
    }
});

app.delete('/v1/jobs/:id', (req, res) => {
    // Legacy support for cancellation if requested
    res.status(200).json({ status: "Cancelled" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
    console.log(`Runner listening on port ${port}`);
});
