import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dockerExec, toRepoRelativePath, type ExecResult, type ScanOutcome, type SemgrepExec } from './semgrep';

export const ESLINT_IMAGE = process.env.ESLINT_IMAGE || 'prism-eslint:9.17.0';
const MAX_SNIPPET_CHARS = 10000;
const CONTAINER_REPO_ROOT = '/src';
const CONTAINER_JOB_DIR = '/job';
/** Extensions the image's configuration has rules for */
export const ESLINT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

export type EslintExec = SemgrepExec;

/**
 * ESLint runs with the repository as its read-only working directory, without network, and
 * with PRism's own configuration from inside the image. Nothing from the repository is executed.
 * `jobDir`, when given, holds files.json: the repository-relative files to lint.
 */
export function buildEslintDockerArgs(workDir: string, containerName: string, jobDir: string | null, image: string = ESLINT_IMAGE): string[] {
    return [
        'run', '--rm',
        '--name', containerName,
        '--network', 'none',
        '--memory', '1g',
        '--cpus', '1.0',
        '--pids-limit', '100',
        '--user', '1000:1000',
        '--read-only',
        '--tmpfs', '/tmp',
        '--log-driver', 'none',
        '-v', `${workDir}:${CONTAINER_REPO_ROOT}:ro`,
        ...(jobDir ? ['-v', `${jobDir}:${CONTAINER_JOB_DIR}:ro`] : []),
        '-w', CONTAINER_REPO_ROOT,
        image,
        ...(jobDir ? [`${CONTAINER_JOB_DIR}/files.json`] : []),
    ];
}

function tail(text: string | undefined, max = 500): string {
    if (!text) return '';
    return text.length > max ? text.slice(-max) : text;
}

/**
 * Decide whether an ESLint process produced a trustworthy result. Only exit code 0 with
 * well-formed output counts as a scan; nothing here ever degrades to "zero findings".
 */
export function interpretEslintExecution(exec: ExecResult): ScanOutcome {
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
                error: `ESLint exited with code ${error.code}: ${tail(stderr) || tail(stdout) || 'no output'}`
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
    if (!parsed || typeof parsed !== 'object' || parsed.tool !== 'eslint' || !Array.isArray(parsed.results)) {
        return { ok: false, code: 'SCAN_MALFORMED_OUTPUT', error: 'Scanner output is not an ESLint result' };
    }
    for (const file of parsed.results) {
        if (!file || typeof file.filePath !== 'string' || !Array.isArray(file.messages)) {
            return { ok: false, code: 'SCAN_MALFORMED_OUTPUT', error: 'Scanner output has a malformed file entry' };
        }
    }
    return { ok: true, result: parsed };
}

/**
 * Make every message self-consistent with the scanned tree:
 *  - the path is repository-relative and resolves inside workDir
 *  - `lines` is the real source text of the reported lines
 *  - `fileSizeLines` is counted from the real file
 * Throws if a file or a message cannot be tied to the tree.
 */
export function canonicalizeEslintResult(workDir: string, result: Record<string, any>): void {
    const root = path.resolve(workDir);

    for (const file of result.results) {
        const relPath = toRepoRelativePath(file.filePath);
        const absolutePath = path.resolve(root, relPath);
        if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
            throw new Error(`Finding path escapes the repository: ${JSON.stringify(file.filePath)}`);
        }
        file.filePath = relPath;

        const lines = fs.readFileSync(absolutePath, 'utf-8').split('\n');
        file.fileSizeLines = lines.length;

        for (const message of file.messages) {
            // A file ESLint could not parse reports one fatal message; it may carry no position.
            const start = Number.isInteger(message.line) && message.line >= 1 ? message.line : 1;
            const end = Number.isInteger(message.endLine) && message.endLine >= start ? message.endLine : start;
            if (start > lines.length) {
                throw new Error(`Finding lines ${start}-${end} are outside ${relPath} (${lines.length} lines)`);
            }
            message.line = start;
            message.endLine = Math.min(end, lines.length);
            message.lines = lines.slice(start - 1, message.endLine).join('\n').substring(0, MAX_SNIPPET_CHARS);
        }
    }
}

/** The repository-relative files worth handing to ESLint: lintable extension, safe path, no duplicates. */
export function selectLintableFiles(files: string[]): string[] {
    const selected = new Set<string>();
    for (const file of files) {
        let rel: string;
        try {
            rel = toRepoRelativePath(file);
        } catch {
            continue; // not a path inside the repository: never passed to the tool
        }
        if (ESLINT_EXTENSIONS.includes(path.extname(rel).toLowerCase())) selected.add(rel);
    }
    return Array.from(selected);
}

/**
 * Lint `files` (repository-relative), or the whole repository when `files` is undefined.
 * An empty or non-lintable list is a completed scan of nothing, not a scan of everything.
 */
export async function runEslintScan(workDir: string, files: string[] | undefined, exec: EslintExec = dockerExec): Promise<ScanOutcome> {
    const containerName = `prism-eslint-${randomBytes(8).toString('hex')}`;
    let jobDir: string | null = null;

    try {
        if (files !== undefined) {
            const lintable = selectLintableFiles(files);
            if (lintable.length === 0) {
                return { ok: true, result: { tool: 'eslint', version: null, results: [], scanned: [] } };
            }
            jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-eslint-job-'));
            fs.writeFileSync(path.join(jobDir, 'files.json'), JSON.stringify(lintable));
        }

        const outcome = interpretEslintExecution(await exec(buildEslintDockerArgs(workDir, containerName, jobDir), containerName));
        if (!outcome.ok) return outcome;

        try {
            canonicalizeEslintResult(workDir, outcome.result);
        } catch (e: any) {
            return { ok: false, code: 'SCAN_NON_CANONICAL_PATH', error: e.message || 'Could not canonicalize scan result' };
        }
        outcome.result.scanned = outcome.result.results.map((r: any) => r.filePath);
        return outcome;
    } finally {
        if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true });
    }
}
