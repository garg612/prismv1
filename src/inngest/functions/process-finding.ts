import { inngest } from "../client";
import { getTarballUrl, getFileAtRef } from "@/modules/github/lib/github";
import { retrieveContext } from "@/modules/ai/lib/rag";
import prisma from "@/lib/db";
import { generateFix } from "@/modules/fix/lib/generate";
import { requestValidation, requestExecutionValidation } from "@/modules/runner/lib/client";
import { computeDelta } from "@/modules/validation/lib/delta";
import { getScanner } from "@/modules/scanners/registry";
import { RUNNER_RESCAN_KEY } from "@/modules/scanners/catalog";
import { determineFixOutcome } from "@/modules/validation/lib/outcome";
import { decideExecutionOutcome, EXEC_CHECKS } from "@/modules/validation/lib/exec-outcome";
import { buildSourceWindow, snippetMatchesSource } from "@/modules/fix/lib/source-window";
import { NonRetriableError } from "inngest";
import { getFixModelName } from "@/lib/ai";
import { planRateLimitWait } from "@/lib/ai-rate-limit";

export const processFinding = inngest.createFunction(
    // At most five fixes are generated and validated at once, across all reviews: that is what
    // keeps the fix model and the runner from being overloaded when a review has many findings.
    { id: "process-finding", concurrency: { limit: 5 }, triggers: [{ event: "finding.surfaced" }] },
    async ({ event, step }: { event: any, step: any }) => {
    const { findingId, reviewRunId } = event.data;

    const findingInfo = await step.run("fetch-finding-info", async () => {
        const finding = await prisma.finding.findUnique({
            where: { id: findingId },
            include: {
                reviewRun: {
                    include: {
                        pullRequest: true,
                        repository: {
                            include: { user: { include: { accounts: { where: { providerId: "github" } } } } }
                        }
                    }
                }
            }
        });
        if (!finding) throw new NonRetriableError("Finding not found");
        if (finding.reviewRunId !== reviewRunId) throw new NonRetriableError("Finding ReviewRun mismatch");
        if (finding.reviewRun.status === "SUPERSEDED") throw new NonRetriableError("ReviewRun is superseded");

        const account = finding.reviewRun.repository.user.accounts[0];
        if (!account?.accessToken) throw new NonRetriableError("No github token");

        if (finding.reviewRun.headSha !== finding.reviewRun.pullRequest.latestHeadSha) {
            throw new NonRetriableError("ReviewRun head SHA is stale");
        }

        return {
            finding,
            account,
            reviewRun: finding.reviewRun
        };
    });

    const { finding, account, reviewRun } = findingInfo;
    const owner = reviewRun.repository.owner;
    const repo = reviewRun.repository.name;
    const headSha = reviewRun.headSha;

    // Related code from the repository index. Indexing writes under the repository id, so that is
    // where to look. It is optional context: a repository that is not indexed, or a lookup that
    // fails, yields none, and the fix is still generated from the real source file.
    const ragStep: Promise<string[]> = step.run("retrieve-rag", async () => {
        if (reviewRun.repository.indexState !== "READY") return [];
        const query = `${finding.message} in ${finding.filePath} rule ${finding.ruleId}`;
        try {
            return await retrieveContext(query, reviewRun.repository.id, 3);
        } catch (e) {
            console.error("Context lookup failed; continuing without it", e);
            return [];
        }
    });

    // The model works from the real file at the exact commit that was scanned.
    const sourceStep = step.run("fetch-source", async () => {
        try {
            const content = await getFileAtRef(account.accessToken!, owner, repo, finding.filePath, headSha);
            const window = buildSourceWindow(finding.filePath, content, finding.startLine, finding.endLine);
            if (!snippetMatchesSource(finding.codeSnippet, window)) {
                return { ok: false as const, reason: `SOURCE_MISMATCH: ${finding.filePath}@${headSha.substring(0, 7)} does not contain the scanned code at lines ${finding.startLine}-${finding.endLine}` };
            }
            return { ok: true as const, content, window };
        } catch (e: any) {
            return { ok: false as const, reason: `SOURCE_UNAVAILABLE: ${e?.message || "could not read source"}` };
        }
    });

    const [ragContext, sourceResult] = await Promise.all([ragStep, sourceStep]);

    if (!sourceResult.ok) {
        await step.run("record-source-failure", async () => {
            await prisma.suggestedFix.create({
                data: {
                    findingId,
                    reviewRunId,
                    status: "NOT_READY",
                    explanation: `No fix was generated. ${sourceResult.reason}`,
                    edits: [],
                    readyAt: new Date()
                }
            });
        });
        return { success: true, outcome: "SOURCE_UNAVAILABLE" };
    }

    const sourceWindow = sourceResult.window;
    // Edits are confined to the file the finding is in.
    const baseFileContents: Record<string, string> = { [finding.filePath]: sourceResult.content };

    let lastError: string | undefined = undefined;
    const MAX_ATTEMPTS = 2;

    // Time spent waiting for the fix model's rate limit, over all attempts for this finding.
    let waitedMs = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let fixGenResult: any;
        // The row of a request the model refused for now; the next try continues it.
        let pendingFixId: string | undefined;

        for (let wait = 0; ; wait++) {
            fixGenResult = await step.run("generate-fix-" + attempt + (wait ? "-after-wait-" + wait : ""), async () => {
                const suggestedFix = pendingFixId ? { id: pendingFixId } : await prisma.suggestedFix.create({
                    data: {
                        findingId,
                        reviewRunId,
                        status: "GENERATING",
                        llmModel: getFixModelName(),
                        edits: []
                    }
                });

                const result = await generateFix(finding, sourceWindow, ragContext, baseFileContents, lastError);

                if (result.status === "RATE_LIMITED") {
                    // A per-minute limit clears quickly: wait as long as the provider asked and try
                    // again, without using up an attempt. A daily limit, or one that does not clear,
                    // ends here with a plain reason.
                    const waitMs = planRateLimitWait(result.rateLimit!, waitedMs, 1000 + Math.floor(Math.random() * 4000));
                    if (waitMs !== null) return { rateLimited: true, waitMs, suggestedFixId: suggestedFix.id };
                    await prisma.suggestedFix.update({
                        where: { id: suggestedFix.id },
                        data: { status: "NOT_READY", explanation: `No fix was generated. ${result.failureReason}`, readyAt: new Date() }
                    });
                    return { rejected: true, generationFailed: true, rateLimitExhausted: true, suggestedFixId: suggestedFix.id, failureReason: result.failureReason };
                }

                if (result.status === "GENERATION_FAILED") {
                    await prisma.suggestedFix.update({
                        where: { id: suggestedFix.id },
                        data: {
                            status: "NOT_READY",
                            explanation: `No fix was generated. ${result.failureReason || "The model did not return a proposal."}`,
                            readyAt: new Date()
                        }
                    });
                    return { rejected: true, generationFailed: true, suggestedFixId: suggestedFix.id, failureReason: result.failureReason };
                }

                if (result.status === "GUARD_REJECTED") {
                    await prisma.suggestedFix.update({
                        where: { id: suggestedFix.id },
                        data: {
                            status: "GUARD_REJECTED",
                            explanation: result.failureReason || "Failed deterministic guards",
                        }
                    });
                    return { rejected: true, generationFailed: false, suggestedFixId: suggestedFix.id, failureReason: result.failureReason };
                }

                await prisma.suggestedFix.update({
                    where: { id: suggestedFix.id },
                    data: {
                        status: "VALIDATING",
                        explanation: result.modelExplanation,
                        selfConfidence: result.selfConfidence,
                        edits: result.proposal!.edits,
                        llmUsage: result.modelUsage
                    }
                });

                await prisma.patch.create({
                    data: {
                        suggestedFixId: suggestedFix.id,
                        unifiedDiff: result.patch!.unifiedDiff,
                        diffSha256: result.patch!.diffSha256,
                        filesChanged: result.patch!.filesChanged,
                        linesAdded: result.patch!.linesAdded,
                        linesRemoved: result.patch!.linesRemoved,
                        baseBlobShas: result.patch!.baseBlobShas,
                    }
                });

                return { rejected: false, generationFailed: false, suggestedFixId: suggestedFix.id, patch: result.patch, edits: result.proposal!.edits };
            });
            if (!fixGenResult.rateLimited) break;
            pendingFixId = fixGenResult.suggestedFixId;
            waitedMs += fixGenResult.waitMs;
            await step.sleep("rate-limit-wait-" + attempt + "-" + (wait + 1), fixGenResult.waitMs);
        }

        if (fixGenResult.rejected) {
            // The model's limit will not clear soon: asking again straight away cannot help.
            if (fixGenResult.rateLimitExhausted) return { success: true, outcome: "RATE_LIMITED" };
            // A guard rejection is fed back to the model; a generation failure has nothing to repair.
            if (!fixGenResult.generationFailed) lastError = fixGenResult.failureReason;
            if (attempt === MAX_ATTEMPTS) {
                return { success: true, outcome: fixGenResult.generationFailed ? "GENERATION_FAILED" : "GUARD_REJECTED" };
            }
            continue;
        }

        const validationRun = await step.run("dispatch-validation-" + attempt, async () => {
            const valRun = await prisma.validationRun.create({
                data: {
                    reviewRunId,
                    suggestedFixId: fixGenResult.suggestedFixId!,
                    kind: "FIXED",
                    tier: "STATIC",
                    status: "PENDING",
                    headSha
                }
            });

            const tarballUrl = await getTarballUrl(account.accessToken!, owner, repo, headSha);
            await requestValidation(valRun.id, tarballUrl, fixGenResult.edits as any, finding.source, [finding.filePath]);

            await prisma.validationRun.update({
                where: { id: valRun.id },
                data: { status: "RUNNING", startedAt: new Date() }
            });

            return valRun;
        });

        const validationEvent = await step.waitForEvent("wait-for-validation-" + attempt, {
            event: "runner.validate.completed",
            if: `async.data.validationRunId == '${validationRun.id}'`,
            timeout: "5m"
        });

        const outcomeResult = await step.run("process-validation-result-" + attempt, async () => {
            const suggestedFixId = fixGenResult.suggestedFixId!;

            if (!validationEvent) {
                await prisma.validationRun.update({
                    where: { id: validationRun.id },
                    data: { status: "TIMEOUT", finishedAt: new Date() }
                });
                await prisma.suggestedFix.update({
                    where: { id: suggestedFixId },
                    data: { status: "NOT_READY", outcome: "VALIDATION_FAILED", readyAt: new Date() }
                });
                return { success: false, reason: "Validation timed out." };
            }

            const data = validationEvent.data;
            const scanner = getScanner(finding.source);
            // The runner reports the re-scan under a neutral key; it is stored as this scanner's own check.
            const checkResults: Record<string, string> = {};
            for (const [key, status] of Object.entries(data.checkResults || {})) {
                checkResults[key === RUNNER_RESCAN_KEY ? scanner.rescanCheck : key] = status as string;
            }
            const patchApplySuccess = checkResults.PATCH_APPLY === "PASSED";
            const syntaxSuccess = checkResults.SYNTAX === "PASSED";
            const rescanSuccess = checkResults[scanner.rescanCheck] === "PASSED";

            await prisma.validationResult.createMany({
                data: Object.entries(checkResults).map(([key, status]) => ({
                    validationRunId: validationRun.id,
                    check: key as any,
                    status: status as any
                }))
            });

            if (data.status === "FAILED") {
                await prisma.validationRun.update({
                    where: { id: validationRun.id },
                    data: { status: "FAILED", finishedAt: new Date() }
                });
                await prisma.suggestedFix.update({
                    where: { id: suggestedFixId },
                    data: { status: "NOT_READY", outcome: "VALIDATION_FAILED", readyAt: new Date() }
                });
                return { success: false, reason: `Validation pipeline failed: ${data.error}` };
            }

            const headScan = await prisma.scanRun.findFirst({
                where: { reviewRunId, kind: "HEAD", source: finding.source, status: "COMPLETED" },
                orderBy: { finishedAt: 'desc' }
            });

            // The re-scan goes through the same adapter as the original scan, so before and after
            // are normalized identically. A re-scan the adapter cannot trust yields no delta, and
            // without a delta the fix is not marked FIXED.
            const rescan = rescanSuccess ? scanner.evaluateScan({ status: "COMPLETED", tool: data.tool, toolResult: data.toolResult }) : null;

            let deltaResult;
            if (headScan && rescan?.ok) {
                const dbHeadFindings = await prisma.finding.findMany({
                    where: { reviewRunId, scanRunId: headScan.id }
                });

                deltaResult = computeDelta(
                    { ruleId: finding.ruleId, filePath: finding.filePath, fingerprint: finding.fingerprint },
                    dbHeadFindings,
                    rescan.findings
                );

                await prisma.validationFinding.createMany({
                    data: deltaResult.deltas.map(d => ({
                        validationRunId: validationRun.id,
                        fingerprint: d.fingerprint,
                        ruleId: d.ruleId,
                        filePath: d.filePath,
                        line: d.line,
                        severity: d.severity as any,
                        delta: d.delta as any
                    }))
                });
            }

            const outcome = determineFixOutcome(patchApplySuccess, syntaxSuccess, rescanSuccess && !!rescan?.ok, deltaResult?.stats);

            await prisma.validationRun.update({
                where: { id: validationRun.id },
                data: { status: "COMPLETED", finishedAt: new Date() }
            });

            await prisma.suggestedFix.update({
                where: { id: suggestedFixId },
                data: {
                    status: outcome === "FIXED" ? "READY" : "NOT_READY",
                    outcome: outcome,
                    readyAt: new Date()
                }
            });

            if (outcome === "FIXED") {
                return { success: true, outcome: "FIXED" };
            } else {
                return { success: false, reason: `Validation failed with outcome: ${outcome}` };
            }
        });

        if (outcomeResult.success && outcomeResult.outcome === "FIXED" && reviewRun.repository.executionValidation) {
            const execValRun = await step.run("dispatch-exec-validation-" + attempt, async () => {
                const valRun = await prisma.validationRun.create({
                    data: {
                        reviewRunId,
                        suggestedFixId: fixGenResult.suggestedFixId!,
                        kind: "FIXED",
                        tier: "EXECUTION",
                        status: "PENDING",
                        headSha
                    }
                });

                const tarballUrl = await getTarballUrl(account.accessToken!, owner, repo, headSha);
                await requestExecutionValidation(valRun.id, tarballUrl, fixGenResult.edits as any, `${reviewRun.repository.id}:${headSha}`);

                await prisma.validationRun.update({
                    where: { id: valRun.id },
                    data: { status: "RUNNING", startedAt: new Date() }
                });

                return valRun;
            });

            const execValidationEvent = await step.waitForEvent("wait-for-exec-validation-" + attempt, {
                event: "runner.validate.completed",
                if: `async.data.validationRunId == '${execValRun.id}'`,
                timeout: "20m" // Up to 20 minutes for execution
            });

            const execOutcomeResult = await step.run("process-exec-validation-result-" + attempt, async () => {
                const suggestedFixId = fixGenResult.suggestedFixId!;

                if (!execValidationEvent) {
                    await prisma.validationRun.update({
                        where: { id: execValRun.id },
                        data: { status: "TIMEOUT", finishedAt: new Date() }
                    });
                    await prisma.suggestedFix.update({
                        where: { id: suggestedFixId },
                        data: { status: "NOT_READY", outcome: "VALIDATION_FAILED", readyAt: new Date() }
                    });
                    return { success: false, retryable: false, reason: "Execution Validation timed out." };
                }

                const data = execValidationEvent.data;
                const execResults = data.execResults; // { provider, baseline: { ... }, fixed: { ... } }

                // Execution did not happen (no sandbox, isolation not established, unverifiable repo...).
                // That is visible and the fix is not READY. It is never treated as a pass.
                if (data.status === "FAILED" || !execResults) {
                    const reason = data.error || "Execution validation produced no results";
                    await prisma.validationRun.update({
                        where: { id: execValRun.id },
                        data: { status: "FAILED", finishedAt: new Date() }
                    });
                    await prisma.validationResult.create({
                        data: {
                            validationRunId: execValRun.id,
                            check: "INSTALL",
                            status: "UNAVAILABLE",
                            summary: `Execution validation did not run: ${reason}`
                        }
                    });
                    await prisma.suggestedFix.update({
                        where: { id: suggestedFixId },
                        data: { status: "NOT_READY", outcome: "UNVERIFIED", readyAt: new Date() }
                    });
                    return { success: false, retryable: false, reason: `Execution validation did not run: ${reason}` };
                }

                const decision = decideExecutionOutcome(execResults);

                // The repository has nothing to execute (a known, repository-level reason). The fix keeps
                // its static result; the skipped checks are recorded with the reason so the page can say so.
                if (decision.outcome === "NOT_APPLICABLE") {
                    await prisma.validationRun.update({
                        where: { id: execValRun.id },
                        data: { status: "COMPLETED", finishedAt: new Date() }
                    });
                    await prisma.validationResult.createMany({
                        data: EXEC_CHECKS.map(check => ({
                            validationRunId: execValRun.id,
                            check: check as any,
                            status: "SKIPPED" as any,
                            summary: decision.reason
                        }))
                    });
                    return { success: true, retryable: false, outcome: "FIXED" };
                }

                // Create a separate ValidationRun for BASELINE to store baseline results
                const baselineValRun = await prisma.validationRun.create({
                    data: {
                        reviewRunId,
                        suggestedFixId: suggestedFixId,
                        kind: "BASELINE",
                        tier: "EXECUTION",
                        status: "COMPLETED",
                        headSha,
                        sandboxProvider: execResults.provider ?? null,
                        finishedAt: new Date()
                    }
                });

                const baseline = execResults.baseline || {};
                const fixed = execResults.fixed || {};
                // CheckStatus has no UNVERIFIABLE; a script we refused to run was not available to run.
                const toCheckStatus = (status: string) => status === "UNVERIFIABLE" ? "UNAVAILABLE" : status;
                const dbResults: any[] = [];

                for (const check of EXEC_CHECKS) {
                    const bRes = baseline[check] || { status: "UNAVAILABLE" };
                    const fRes = fixed[check] || { status: "UNAVAILABLE" };

                    dbResults.push({
                        validationRunId: baselineValRun.id,
                        check: check as any,
                        status: toCheckStatus(bRes.status) as any,
                        exitCode: bRes.exitCode,
                        durationMs: bRes.duration,
                        logExcerpt: bRes.log,
                        summary: bRes.error
                    });
                    dbResults.push({
                        validationRunId: execValRun.id,
                        check: check as any,
                        status: toCheckStatus(fRes.status) as any,
                        exitCode: fRes.exitCode,
                        durationMs: fRes.duration,
                        logExcerpt: fRes.log,
                        summary: fRes.error
                    });
                }

                await prisma.validationResult.createMany({
                    data: dbResults
                });

                await prisma.validationRun.update({
                    where: { id: execValRun.id },
                    data: { status: "COMPLETED", finishedAt: new Date(), sandboxProvider: execResults.provider ?? null }
                });

                if (decision.outcome === "FIXED") {
                    return { success: true, retryable: false, outcome: "FIXED" };
                }

                // The static tier already marked this fix READY; execution did not confirm it.
                await prisma.suggestedFix.update({
                    where: { id: suggestedFixId },
                    data: {
                        status: "NOT_READY",
                        outcome: decision.outcome === "UNVERIFIED" ? "UNVERIFIED" : "VALIDATION_FAILED",
                        readyAt: new Date()
                    }
                });
                // Only a regression is something another model attempt could fix.
                return { success: false, retryable: decision.outcome === "VALIDATION_FAILED", reason: decision.reason };
            });

            if (!execOutcomeResult.success) {
                lastError = execOutcomeResult.reason;
                if (attempt === MAX_ATTEMPTS || !execOutcomeResult.retryable) return { success: true, outcome: "NOT_READY" };
                continue;
            }
        }

        if (outcomeResult.success) {
            return { success: true, outcome: "FIXED" };
        } else {
            lastError = outcomeResult.reason;
            if (attempt === MAX_ATTEMPTS) return { success: true, outcome: "NOT_READY" };
        }
    }

    return { success: true };
});
