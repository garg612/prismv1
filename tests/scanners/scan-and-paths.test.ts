/**
 * P0 correctness gate — items 2 and 5:
 * canonical repository-relative paths end to end, and scans that fail closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    buildSemgrepDockerArgs,
    interpretSemgrepExecution,
    canonicalizeSemgrepResult,
    runSemgrepScan,
    ExecResult,
} from '../../services/runner/src/semgrep';
import { applyEditsToTree } from '../../services/runner/src/edits';
import { toRepoRelativePath, NonCanonicalPathError } from '../../src/modules/scanners/semgrep/path';
import { evaluateScanCallback } from '../../src/modules/scanners/semgrep/scan-result';
import { parseDiffHunks, isInChangedLines } from '../../src/modules/review/lib/diff-hunks';
import { computeDelta, hashSemgrepMatch } from '../helpers/semgrep-delta';
import { determineFixOutcome } from '../../src/modules/validation/lib/outcome';
import { buildMLFeatures } from '../../src/modules/triage/lib/features';
import { buildSourceWindow, snippetMatchesSource } from '../../src/modules/fix/lib/source-window';

const SOURCE = [
    'const db = require("./db");',
    '',
    'function getUser(id) {',
    '    if (!id) {',
    '        return null;',
    '    }',
    '    return db.query("SELECT * FROM users WHERE id = " + id);',
    '}',
    '',
    'module.exports = { getUser };',
    ''
].join('\n');

/** What Semgrep 1.178 really emits with `-w /src ... .`: relative path, placeholder lines. */
const rawFinding = (overrides: Record<string, any> = {}) => ({
    check_id: 'prism-sql-injection',
    path: 'lib/users.js',
    start: { line: 7, col: 12 },
    end: { line: 7, col: 61 },
    extra: { message: 'Potential SQL injection', severity: 'ERROR', metadata: { category: 'SECURITY' }, lines: 'requires login' },
    ...overrides
});

const okExec = (payload: unknown): ExecResult => ({ error: null, stdout: JSON.stringify(payload), stderr: '' });

let repoDir: string;
beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-scan-'));
    fs.mkdirSync(path.join(repoDir, 'lib'));
    fs.writeFileSync(path.join(repoDir, 'lib', 'users.js'), SOURCE);
});
afterAll(() => fs.rmSync(repoDir, { recursive: true, force: true }));

describe('P0-2 Semgrep runs from the repository root', () => {
    it('uses the repo as working directory and scans "."', () => {
        const args = buildSemgrepDockerArgs('/work/repo', '/rules/r.yaml', 'c1', 'semgrep/semgrep:test');
        expect(args[args.indexOf('-w') + 1]).toBe('/src');
        expect(args).toContain('/work/repo:/src:ro');
        expect(args[args.length - 1]).toBe('.');
        // "/src" appears only as the working directory, never as the scan target
        expect(args.filter(a => a === '/src')).toHaveLength(1);
        expect(args[args.indexOf('--network') + 1]).toBe('none');
    });
});

describe('P0-2 one canonical path definition', () => {
    it('accepts repository-relative paths and normalizes separators', () => {
        expect(toRepoRelativePath('lib/users.js')).toBe('lib/users.js');
        expect(toRepoRelativePath('./lib/users.js')).toBe('lib/users.js');
        expect(toRepoRelativePath('lib\\users.js')).toBe('lib/users.js');
    });

    it('rejects absolute, drive and traversal paths rather than rewriting them', () => {
        for (const bad of ['/src/lib/users.js', 'C:/repo/a.js', '../a.js', 'a/../../b.js', 'a//b.js', '']) {
            expect(() => toRepoRelativePath(bad), bad).toThrow(NonCanonicalPathError);
        }
    });
});

describe('P0-2 canonical scan result drives every downstream consumer', () => {
    const canonical = () => {
        const result = { results: [rawFinding()], errors: [], paths: { scanned: ['./lib/users.js'] }, version: '1.178.0' };
        canonicalizeSemgrepResult(repoDir, result);
        return result;
    };

    it('finding.filePath is repository-relative', () => {
        const evaluation = evaluateScanCallback({ status: 'COMPLETED', toolResult: canonical() as any });
        expect(evaluation.ok).toBe(true);
        if (!evaluation.ok) return;
        expect(evaluation.findings[0].filePath).toBe('lib/users.js');
        expect(evaluation.scannedFiles).toBe(1);
        expect(evaluation.toolVersion).toBe('1.178.0');
    });

    it('the snippet is the real source line, not the Semgrep placeholder', () => {
        const f = canonical().results[0];
        expect(f.extra.lines).toBe('    return db.query("SELECT * FROM users WHERE id = " + id);');
    });

    it('AST metrics are measured from the real file', () => {
        const features = (canonical().results[0].extra as any).prism_features;
        expect(features.fileSizeLines).toBe(SOURCE.split('\n').length);
        expect(features.functionLength).toBe(6);       // getUser spans lines 3-8
        expect(features.cyclomaticComplexity).toBe(2); // one `if`
    });

    it('measured AST metrics make a real ML feature payload', () => {
        const f = canonical().results[0];
        const payload = buildMLFeatures({
            id: 'F1', ruleId: f.check_id, severity: 'HIGH', filePath: f.path, codeSnippet: f.extra.lines,
            metadata: { prism_features: (f.extra as any).prism_features }
        } as any, 10, null, null, null);
        expect(payload).not.toBeNull();
        expect(payload!.function_length).toBe(6);
        expect(payload!.pr_change_code).toContain('db.query(');
    });

    it('inChangedLines matches the diff, which is keyed by the same path', () => {
        const diff = [
            'diff --git a/lib/users.js b/lib/users.js',
            '--- a/lib/users.js',
            '+++ b/lib/users.js',
            '@@ -5,2 +5,4 @@',
            '+    return db.query("SELECT * FROM users WHERE id = " + id);',
        ].join('\n');
        const hunks = parseDiffHunks(diff);
        const evaluation = evaluateScanCallback({ status: 'COMPLETED', toolResult: canonical() as any });
        if (!evaluation.ok) throw new Error('expected ok');
        const finding = evaluation.findings[0];

        expect(isInChangedLines(hunks, finding.filePath, finding.startLine, finding.endLine)).toBe(true);
        // The pre-fix path form never matched the diff
        expect(isInChangedLines(hunks, 'src/lib/users.js', finding.startLine, finding.endLine)).toBe(false);
        expect(isInChangedLines(hunks, finding.filePath, 1, 2)).toBe(false);
    });

    it('source lookup with the finding path and lines finds the scanned code', () => {
        const evaluation = evaluateScanCallback({ status: 'COMPLETED', toolResult: canonical() as any });
        if (!evaluation.ok) throw new Error('expected ok');
        const finding = evaluation.findings[0];

        const content = fs.readFileSync(path.join(repoDir, finding.filePath), 'utf8');
        const window = buildSourceWindow(finding.filePath, content, finding.startLine, finding.endLine);
        expect(snippetMatchesSource(finding.codeSnippet, window)).toBe(true);
    });

    it('validation delta: a fix that removes the finding is FIXED', () => {
        const head = canonical().results;
        const fingerprint = hashSemgrepMatch(head[0] as any);

        const delta = computeDelta('prism-sql-injection', 'lib/users.js', fingerprint, head as any, []);
        expect(delta.stats.targetFindingStatus).toBe('REMOVED');
        expect(delta.stats.newFindingsCount).toBe(0);
        expect(determineFixOutcome(true, true, true, delta.stats)).toBe('FIXED');
    });

    it('validation delta: an unrelated finding that was already there is not counted as new', () => {
        const other = rawFinding({ check_id: 'prism-console-log', start: { line: 1 }, end: { line: 1 }, extra: { message: 'm', severity: 'WARNING', lines: 'requires login' } });
        const headResult = { results: [rawFinding(), other], errors: [] };
        canonicalizeSemgrepResult(repoDir, headResult);
        const postResult = { results: [{ ...other, path: './lib/users.js', extra: { ...other.extra } }], errors: [] };
        canonicalizeSemgrepResult(repoDir, postResult);

        const fingerprint = hashSemgrepMatch(headResult.results[0] as any);
        const delta = computeDelta('prism-sql-injection', 'lib/users.js', fingerprint, headResult.results as any, postResult.results as any);
        expect(delta.stats.targetFindingStatus).toBe('REMOVED');
        expect(delta.stats.newFindingsCount).toBe(0);
    });

    it('validation delta: a finding that survives the fix is NOT_FIXED', () => {
        const head = canonical().results;
        const post = canonical().results;
        const delta = computeDelta('prism-sql-injection', 'lib/users.js', hashSemgrepMatch(head[0] as any), head as any, post as any);
        expect(delta.stats.targetFindingStatus).toBe('UNCHANGED');
        expect(determineFixOutcome(true, true, true, delta.stats)).toBe('NOT_FIXED');
    });

    it('validation delta: ADDED findings carry a valid Severity enum value', () => {
        const added = rawFinding({ check_id: 'prism-command-injection' });
        const post = { results: [added], errors: [] };
        canonicalizeSemgrepResult(repoDir, post);
        const delta = computeDelta('prism-sql-injection', 'lib/users.js', 'none', [], post.results as any);
        const addedDelta = delta.deltas.find(d => d.delta === 'ADDED');
        expect(addedDelta.severity).toBe('HIGH'); // Semgrep "ERROR" is not a Severity value
        expect(addedDelta.filePath).toBe('lib/users.js');
    });

    it('a finding whose file is not in the tree fails canonicalization', () => {
        const result = { results: [rawFinding({ path: 'lib/missing.js' })], errors: [] };
        expect(() => canonicalizeSemgrepResult(repoDir, result)).toThrow();
    });

    it('an absolute container path fails canonicalization', () => {
        const result = { results: [rawFinding({ path: '/src/lib/users.js' })], errors: [] };
        expect(() => canonicalizeSemgrepResult(repoDir, result)).toThrow(/not repository-relative/);
    });
});

describe('P0-5 the runner never reports a failed scan as clean', () => {
    it('exit 0 with valid JSON and no errors is the only success', () => {
        const out = interpretSemgrepExecution(okExec({ results: [], errors: [] }));
        expect(out.ok).toBe(true);
    });

    it('non-zero exit is a failure even when stdout is parseable JSON with zero results', () => {
        const error = Object.assign(new Error('Command failed'), { code: 2 });
        const out = interpretSemgrepExecution({ error, stdout: JSON.stringify({ results: [], errors: [] }), stderr: 'fatal' });
        expect(out).toMatchObject({ ok: false, code: 'SCAN_NONZERO_EXIT', exitCode: 2 });
    });

    it('timeout is a failure', () => {
        const error = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
        expect(interpretSemgrepExecution({ error, stdout: '', stderr: '' })).toMatchObject({ ok: false, code: 'SCAN_TIMEOUT' });
    });

    it('truncated output is a failure', () => {
        const error = Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        expect(interpretSemgrepExecution({ error, stdout: '{"results":[', stderr: '' })).toMatchObject({ ok: false, code: 'SCAN_OUTPUT_TOO_LARGE' });
    });

    it('docker not available is a failure', () => {
        const error = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
        expect(interpretSemgrepExecution({ error, stdout: '', stderr: '' })).toMatchObject({ ok: false, code: 'SCAN_SPAWN_FAILED' });
    });

    it('malformed output is a failure', () => {
        for (const stdout of ['', 'not json', '{"results": 5}', 'null', '{"errors": []}']) {
            expect(interpretSemgrepExecution({ error: null, stdout, stderr: '' }), stdout).toMatchObject({ ok: false, code: 'SCAN_MALFORMED_OUTPUT' });
        }
    });

    it('exit 0 with a rule parse error is a failure (observed Semgrep 1.178 behaviour)', () => {
        const out = interpretSemgrepExecution(okExec({
            results: [],
            errors: [{ code: 2, level: 'error', type: 'Rule parse error', rule_id: 'broken', message: 'Invalid pattern' }]
        }));
        expect(out).toMatchObject({ ok: false, code: 'SCAN_TOOL_ERRORS' });
    });

    it('warn-level diagnostics do not fail the scan', () => {
        const out = interpretSemgrepExecution(okExec({ results: [], errors: [{ level: 'warn', type: 'PartialParsing', message: 'x' }] }));
        expect(out.ok).toBe(true);
    });

    it('runSemgrepScan passes failures through and canonicalizes successes', async () => {
        const failing = await runSemgrepScan(repoDir, '/rules.yaml', async () => ({ error: Object.assign(new Error('x'), { code: 7 }), stdout: '', stderr: 'boom' }));
        expect(failing).toMatchObject({ ok: false, code: 'SCAN_NONZERO_EXIT' });

        const ok = await runSemgrepScan(repoDir, '/rules.yaml', async () => okExec({ results: [rawFinding()], errors: [] }));
        expect(ok.ok).toBe(true);
        if (ok.ok) expect(ok.result.results[0].extra.lines).toContain('db.query(');

        const bad = await runSemgrepScan(repoDir, '/rules.yaml', async () => okExec({ results: [rawFinding({ path: '/src/lib/users.js' })], errors: [] }));
        expect(bad).toMatchObject({ ok: false, code: 'SCAN_NON_CANONICAL_PATH' });
    });
});

describe('P0-5 the orchestrator never treats a failed scan as zero findings', () => {
    it('no callback (timeout) is a failure', () => {
        expect(evaluateScanCallback(null)).toMatchObject({ ok: false, code: 'SCAN_TIMEOUT', jobStatus: 'TIMEOUT' });
    });

    it('a FAILED callback is a failure and keeps the runner error code', () => {
        const out = evaluateScanCallback({ status: 'FAILED', errorCode: 'SCAN_NONZERO_EXIT', error: 'SCAN_NONZERO_EXIT: Semgrep exited with code 2' });
        expect(out).toMatchObject({ ok: false, code: 'SCAN_NONZERO_EXIT', jobStatus: 'FAILED' });
    });

    it('a FAILED callback that still carries results is a failure', () => {
        const out = evaluateScanCallback({ status: 'FAILED', toolResult: { results: [] } as any });
        expect(out.ok).toBe(false);
    });

    it('COMPLETED without a result is a failure', () => {
        expect(evaluateScanCallback({ status: 'COMPLETED' })).toMatchObject({ ok: false, code: 'SCAN_RESULT_MISSING' });
    });

    it('COMPLETED with error-level tool errors is a failure', () => {
        const out = evaluateScanCallback({ status: 'COMPLETED', toolResult: { results: [], errors: [{ level: 'error', message: 'Rule parse error' }] } as any });
        expect(out).toMatchObject({ ok: false, code: 'SCAN_TOOL_ERRORS' });
    });

    it('a non-canonical path in a result is a failure', () => {
        const out = evaluateScanCallback({ status: 'COMPLETED', toolResult: { results: [rawFinding({ path: '/src/a.js', extra: { message: 'm', severity: 'ERROR', lines: 'x' } })] } as any });
        expect(out).toMatchObject({ ok: false, code: 'SCAN_NON_CANONICAL_PATH' });
    });

    it('placeholder snippets are a failure', () => {
        const out = evaluateScanCallback({ status: 'COMPLETED', toolResult: { results: [rawFinding()] } as any });
        expect(out).toMatchObject({ ok: false, code: 'SCAN_SNIPPET_UNAVAILABLE' });
    });

    it('a genuinely clean scan is ok with zero findings', () => {
        const out = evaluateScanCallback({ status: 'COMPLETED', toolResult: { results: [], errors: [], paths: { scanned: ['a.js'] } } as any });
        expect(out).toMatchObject({ ok: true, findings: [], scannedFiles: 1 });
    });

    it('the orchestrator stops the run on HEAD and BASE scan failure, before billing', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/inngest/functions/review-run.ts'), 'utf8');
        const headThrow = src.indexOf('new PipelineFailure("SCAN", `HEAD_${head.evaluation.code}`');
        const baseThrow = src.indexOf('`BASE_${base.evaluation.code}`');
        const persist = src.indexOf('step.run("persist-findings"');
        const billing = src.indexOf('billedAt: new Date()');

        expect(headThrow).toBeGreaterThan(0);
        expect(baseThrow).toBeGreaterThan(headThrow);
        expect(persist).toBeGreaterThan(baseThrow);
        expect(billing).toBeGreaterThan(persist);
        // The old fail-open branches are gone
        expect(src).not.toMatch(/status !== "COMPLETED"[^\n]*\n[^\n]*\n\s*return \[\];/);
        expect(src).not.toContain('return [];');
    });
});

describe('runner edit application', () => {
    let tree: string;
    beforeAll(() => {
        tree = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-edits-'));
        fs.writeFileSync(path.join(tree, 'a.js'), 'const total = cost;\n');
    });
    afterAll(() => fs.rmSync(tree, { recursive: true, force: true }));

    it('applies a literal edit, keeping "$" sequences literal', () => {
        expect(applyEditsToTree(tree, [{ path: 'a.js', find: 'cost', replace: 'price("$&")' }])).toBe(true);
        expect(fs.readFileSync(path.join(tree, 'a.js'), 'utf8')).toBe('const total = price("$&");\n');
    });

    it('fails when the find string is absent instead of silently doing nothing', () => {
        expect(applyEditsToTree(tree, [{ path: 'a.js', find: 'not present', replace: 'x' }])).toBe(false);
    });

    it('fails for missing files and for paths outside the tree', () => {
        expect(applyEditsToTree(tree, [{ path: 'missing.js', find: 'a', replace: 'b' }])).toBe(false);
        expect(applyEditsToTree(tree, [{ path: '../outside.js', find: 'a', replace: 'b' }])).toBe(false);
        expect(applyEditsToTree(tree, [{ path: '/etc/passwd', find: 'a', replace: 'b' }])).toBe(false);
    });
});
