import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { extractASTMetrics } from './ast';

export const SEMGREP_IMAGE = process.env.SEMGREP_IMAGE || 'semgrep/semgrep:latest';
export const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_SNIPPET_CHARS = 10000;
const CONTAINER_REPO_ROOT = '/src';

export type ScanFailureCode =
    | 'SCAN_TIMEOUT'
    | 'SCAN_OUTPUT_TOO_LARGE'
    | 'SCAN_NONZERO_EXIT'
    | 'SCAN_SPAWN_FAILED'
    | 'SCAN_MALFORMED_OUTPUT'
    | 'SCAN_TOOL_ERRORS'
    | 'SCAN_NON_CANONICAL_PATH';

export type ScanOutcome =
    | { ok: true; result: Record<string, any> }
    | { ok: false; code: ScanFailureCode; error: string; exitCode?: number };

export interface ExecResult {
    error: (Error & { code?: number | string; killed?: boolean; signal?: string | null }) | null;
    stdout: string;
    stderr: string;
}

export type SemgrepExec = (args: string[], containerName: string) => Promise<ExecResult>;

/**
 * Semgrep runs with the repository root as its working directory and scans ".",
 * so every path it reports is already repository-relative.
 */
export function buildSemgrepDockerArgs(workDir: string, rulesPath: string, containerName: string, image: string = SEMGREP_IMAGE): string[] {
    return [
        'run', '--rm',
        '--name', containerName,
        '--network', 'none',
        '--memory', '1g',
        '--cpus', '1.0',
        '--pids-limit', '50',
        '--user', '1000:1000',
        '--tmpfs', '/tmp',
        '--log-driver', 'none',
        '-v', `${workDir}:${CONTAINER_REPO_ROOT}:ro`,
        '-v', `${rulesPath}:/rules.yaml:ro`,
        '-w', CONTAINER_REPO_ROOT,
        // The container has no network. Left on, the version check waits ~2 minutes for a
        // connection that cannot happen. It has no effect on rules or findings.
        '-e', 'SEMGREP_ENABLE_VERSION_CHECK=0',
        image,
        'semgrep', 'scan', '--config', '/rules.yaml', '--json', '--metrics', 'off', '--disable-version-check', '.'
    ];
}

/** Same contract as the app's toRepoRelativePath: reject, never rewrite. */
export function toRepoRelativePath(rawPath: string): string {
    let p = String(rawPath).replace(/\\/g, '/');
    while (p.startsWith('./')) p = p.substring(2);
    const segments = p.split('/');
    if (
        p === '' ||
        p.startsWith('/') ||
        /^[A-Za-z]:/.test(p) ||
        p.includes('\0') ||
        segments.some(s => s === '' || s === '.' || s === '..')
    ) {
        throw new Error(`Path is not repository-relative: ${JSON.stringify(rawPath)}`);
    }
    return p;
}

function tail(text: string | undefined, max = 500): string {
    if (!text) return '';
    return text.length > max ? text.slice(-max) : text;
}

/**
 * Decide whether a Semgrep process produced a trustworthy result.
 * Only exit code 0 + well-formed JSON + no error-level tool errors counts as a scan.
 * Everything else is a failure; nothing here ever degrades to "zero findings".
 */
export function interpretSemgrepExecution(exec: ExecResult): ScanOutcome {
    const { error, stdout, stderr } = exec;

    if (error) {
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return { ok: false, code: 'SCAN_OUTPUT_TOO_LARGE', error: 'Scanner output exceeded the buffer limit' };
        }
        if (error.killed || error.signal) {
            return { ok: false, code: 'SCAN_TIMEOUT', error: `Scanner was terminated (${error.signal || 'timeout'})` };
        }
        if (typeof error.code === 'number') {
            return {
                ok: false,
                code: 'SCAN_NONZERO_EXIT',
                exitCode: error.code,
                error: `Semgrep exited with code ${error.code}: ${tail(stderr) || tail(stdout) || 'no output'}`
            };
        }
        return { ok: false, code: 'SCAN_SPAWN_FAILED', error: error.message || 'Failed to start scanner' };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return { ok: false, code: 'SCAN_MALFORMED_OUTPUT', error: 'Scanner output is not valid JSON' };
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.results)) {
        return { ok: false, code: 'SCAN_MALFORMED_OUTPUT', error: 'Scanner output has no results array' };
    }
    if (parsed.errors !== undefined && !Array.isArray(parsed.errors)) {
        return { ok: false, code: 'SCAN_MALFORMED_OUTPUT', error: 'Scanner output has a malformed errors field' };
    }

    // Semgrep can exit 0 with results: [] when a rule fails to parse. That is not a clean scan.
    const fatal = (parsed.errors || []).filter((e: any) => String(e?.level || '').toLowerCase() === 'error');
    if (fatal.length > 0) {
        const first = fatal[0];
        return {
            ok: false,
            code: 'SCAN_TOOL_ERRORS',
            error: `Semgrep reported ${fatal.length} error(s): ${first?.type || 'error'}: ${tail(String(first?.message || ''), 300)}`
        };
    }

    return { ok: true, result: parsed };
}

function readSourceLines(absolutePath: string, startLine: number, endLine: number): string {
    const lines = fs.readFileSync(absolutePath, 'utf-8').split('\n');
    if (startLine < 1 || endLine < startLine || startLine > lines.length) {
        throw new Error(`Finding lines ${startLine}-${endLine} are outside the file (${lines.length} lines)`);
    }
    return lines.slice(startLine - 1, endLine).join('\n').substring(0, MAX_SNIPPET_CHARS);
}

/**
 * Make every finding self-consistent with the scanned tree:
 *  - path is repository-relative and resolves inside workDir
 *  - extra.lines is the real source text (Semgrep OSS emits "requires login")
 *  - extra.prism_features comes from the real file, or is absent — never placeholder zeros
 * Throws if any finding cannot be tied to a file in the tree.
 */
export function canonicalizeSemgrepResult(workDir: string, result: Record<string, any>): void {
    const root = path.resolve(workDir);

    for (const finding of result.results) {
        const relPath = toRepoRelativePath(finding.path);
        const absolutePath = path.resolve(root, relPath);
        if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
            throw new Error(`Finding path escapes the repository: ${JSON.stringify(finding.path)}`);
        }
        finding.path = relPath;

        if (!finding.extra) finding.extra = {};
        finding.extra.lines = readSourceLines(absolutePath, finding.start.line, finding.end.line);

        try {
            finding.extra.prism_features = extractASTMetrics(absolutePath, finding.start.line);
        } catch {
            delete finding.extra.prism_features;
        }
    }

    if (result.paths && Array.isArray(result.paths.scanned)) {
        result.paths.scanned = result.paths.scanned.map((p: string) => toRepoRelativePath(p));
    }
}

export const dockerExec: SemgrepExec = (args, containerName) =>
    new Promise(resolve => {
        execFile('docker', args, { maxBuffer: MAX_OUTPUT_BYTES, timeout: SCAN_TIMEOUT_MS }, (error, stdout, stderr) => {
            if (error && ((error as any).killed || (error as any).signal)) {
                // Killing the docker CLI does not reliably stop the container.
                execFile('docker', ['kill', containerName], () => resolve({ error: error as any, stdout, stderr }));
                return;
            }
            resolve({ error: error as any, stdout, stderr });
        });
    });

export async function runSemgrepScan(workDir: string, rulesPath: string, exec: SemgrepExec = dockerExec): Promise<ScanOutcome> {
    const containerName = `prism-semgrep-${randomBytes(8).toString('hex')}`;
    const args = buildSemgrepDockerArgs(workDir, rulesPath, containerName);

    const outcome = interpretSemgrepExecution(await exec(args, containerName));
    if (!outcome.ok) return outcome;

    try {
        canonicalizeSemgrepResult(workDir, outcome.result);
    } catch (e: any) {
        return { ok: false, code: 'SCAN_NON_CANONICAL_PATH', error: e.message || 'Could not canonicalize scan result' };
    }
    return outcome;
}
