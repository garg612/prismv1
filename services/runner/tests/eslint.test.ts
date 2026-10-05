/**
 * The ESLint scanner in the runner.
 *
 * UNIT: how the container is started, how its result is judged, how findings are tied to the tree.
 * LIVE (needs docker and the prism-eslint image; skipped otherwise): a real lint of a real tree.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    buildEslintDockerArgs, canonicalizeEslintResult, ESLINT_IMAGE, interpretEslintExecution, runEslintScan, selectLintableFiles,
} from '../src/eslint';
import { getScanner, listScannerIds } from '../src/scanners';

const tree = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-eslint-test-'));
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
};
const output = (results: unknown[]) => JSON.stringify({ tool: 'eslint', version: '9.17.0', results });
const msg = (over: Record<string, unknown> = {}) => ({ ruleId: 'no-undef', severity: 2, message: 'x is not defined.', line: 2, column: 1, endLine: 2, endColumn: 2, fatal: false, fix: null, suggestionCount: 0, ...over });
const dirs: string[] = [];
const temp = (files: Record<string, string>) => { const d = tree(files); dirs.push(d); return d; };
afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

describe('how the ESLint container is started', () => {
    const args = buildEslintDockerArgs('/work/repo', 'prism-eslint-abc', '/work/job');

    it('has no network, a read-only root and a read-only repository', () => {
        expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'none']);
        expect(args).toContain('--read-only');
        expect(args).toContain('/work/repo:/src:ro');
        expect(args).toContain('/work/job:/job:ro');
    });

    it('runs unprivileged with memory, cpu and process limits', () => {
        const value = (flag: string) => args[args.indexOf(flag) + 1];
        expect(value('--user')).toBe('1000:1000');
        expect(value('--memory')).toBe('1g');
        expect(value('--cpus')).toBe('1.0');
        expect(Number(value('--pids-limit'))).toBeGreaterThan(0);
    });

    it('never passes repository-controlled text on the command line', () => {
        // The only argument after the image is the fixed path of the file list.
        expect(args.slice(args.indexOf(ESLINT_IMAGE) + 1)).toEqual(['/job/files.json']);
        expect(buildEslintDockerArgs('/work/repo', 'c', null).slice(-1)).toEqual([ESLINT_IMAGE]);
    });
});

describe('judging what the container returned', () => {
    const exec = (over: Record<string, unknown>) => ({ error: null, stdout: '', stderr: '', ...over }) as any;

    it('accepts only exit 0 with well-formed ESLint output', () => {
        expect(interpretEslintExecution(exec({ stdout: output([]) }))).toMatchObject({ ok: true });
    });

    it('fails closed on everything else', () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ error: Object.assign(new Error('x'), { code: 2 }), stderr: 'Oops' }, 'SCAN_NONZERO_EXIT'],
            [{ error: Object.assign(new Error('x'), { code: 125 }), stderr: 'Unable to find image' }, 'SCAN_NONZERO_EXIT'],
            [{ error: Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }) }, 'SCAN_TIMEOUT'],
            [{ error: Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }, 'SCAN_OUTPUT_TOO_LARGE'],
            [{ error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) }, 'SCAN_SPAWN_FAILED'],
            [{ stdout: '' }, 'SCAN_MALFORMED_OUTPUT'],
            [{ stdout: 'not json' }, 'SCAN_MALFORMED_OUTPUT'],
            [{ stdout: '[]' }, 'SCAN_MALFORMED_OUTPUT'],
            [{ stdout: JSON.stringify({ results: [], errors: [] }) }, 'SCAN_MALFORMED_OUTPUT'], // Semgrep's shape
            [{ stdout: output([{ filePath: 'a.js' }]) }, 'SCAN_MALFORMED_OUTPUT'],
        ];
        for (const [input, code] of cases) expect(interpretEslintExecution(exec(input))).toMatchObject({ ok: false, code });
    });

    it('says which image is missing when docker cannot find it', () => {
        const outcome = interpretEslintExecution(exec({ error: Object.assign(new Error('x'), { code: 125 }), stderr: "Unable to find image 'prism-eslint:9.17.0' locally" }));
        expect(outcome).toMatchObject({ ok: false, exitCode: 125 });
        if (!outcome.ok) expect(outcome.error).toMatch(/Unable to find image/);
    });
});

describe('tying findings to the scanned tree', () => {
    it('adds the real source lines and the real file size', () => {
        const dir = temp({ 'lib/a.js': 'const a = 1;\nreturn x;\nfoo();\n' });
        const result: any = { results: [{ filePath: 'lib/a.js', messages: [msg(), msg({ line: 2, endLine: 3 })] }] };
        canonicalizeEslintResult(dir, result);
        expect(result.results[0].fileSizeLines).toBe(4);
        expect(result.results[0].messages[0].lines).toBe('return x;');
        expect(result.results[0].messages[1].lines).toBe('return x;\nfoo();');
    });

    it('gives a parse error without a position the first line, not an invented one', () => {
        const dir = temp({ 'broken.js': 'function ( {\n' });
        const result: any = { results: [{ filePath: 'broken.js', messages: [msg({ ruleId: null, fatal: true, line: null, endLine: null })] }] };
        canonicalizeEslintResult(dir, result);
        expect(result.results[0].messages[0]).toMatchObject({ line: 1, endLine: 1, lines: 'function ( {' });
    });

    it('rejects a path outside the repository and a line outside the file', () => {
        const dir = temp({ 'a.js': 'x\n' });
        for (const filePath of ['../a.js', '/etc/passwd', 'sub/../../a.js', 'C:/x.js']) {
            expect(() => canonicalizeEslintResult(dir, { results: [{ filePath, messages: [] }] })).toThrow(/not repository-relative|escapes/);
        }
        expect(() => canonicalizeEslintResult(dir, { results: [{ filePath: 'a.js', messages: [msg({ line: 99, endLine: 99 })] }] })).toThrow(/outside a\.js/);
        expect(() => canonicalizeEslintResult(dir, { results: [{ filePath: 'missing.js', messages: [] }] })).toThrow();
    });
});

describe('which files are handed to ESLint', () => {
    it('keeps lintable files inside the repository, once each', () => {
        expect(selectLintableFiles(['src/a.js', './src/a.js', 'b.TSX', 'c.mjs', 'README.md', 'x.py', 'img.png', '../evil.js', '/abs.js', 'a/../../b.js', '']))
            .toEqual(['src/a.js', 'b.TSX', 'c.mjs']);
    });
});

describe('runEslintScan', () => {
    it('lints nothing, and starts no container, when no changed file is lintable', async () => {
        const exec = jest.fn();
        const outcome = await runEslintScan(temp({ 'README.md': '# hi' }), ['README.md', 'x.py'], exec as any);
        expect(outcome).toEqual({ ok: true, result: { tool: 'eslint', version: null, results: [], scanned: [] } });
        expect(exec).not.toHaveBeenCalled();
    });

    it('passes the file list through a read-only job directory and removes it afterwards', async () => {
        const dir = temp({ 'lib/a.js': 'a\nb\n' });
        let jobDir = '';
        const exec = jest.fn(async (args: string[]) => {
            jobDir = args.find(a => a.endsWith(':/job:ro'))!.replace(/:\/job:ro$/, '');
            expect(JSON.parse(fs.readFileSync(path.join(jobDir, 'files.json'), 'utf8'))).toEqual(['lib/a.js']);
            return { error: null, stdout: output([{ filePath: 'lib/a.js', messages: [msg()] }]), stderr: '' };
        });
        const outcome = await runEslintScan(dir, ['lib/a.js', 'notes.txt'], exec as any);
        expect(outcome).toMatchObject({ ok: true });
        if (outcome.ok) {
            expect(outcome.result.scanned).toEqual(['lib/a.js']);
            expect(outcome.result.results[0].messages[0].lines).toBe('b');
        }
        expect(fs.existsSync(jobDir)).toBe(false);
    });

    it('lints the whole repository when no list is given', async () => {
        const exec = jest.fn(async (args: string[]) => {
            expect(args.some(a => a.endsWith(':/job:ro'))).toBe(false);
            return { error: null, stdout: output([]), stderr: '' };
        });
        expect(await runEslintScan(temp({ 'a.js': '' }), undefined, exec as any)).toMatchObject({ ok: true });
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('reports a failed container as a failed scan and still cleans up', async () => {
        const exec = jest.fn(async () => ({ error: Object.assign(new Error('x'), { code: 2 }), stdout: '', stderr: 'crash' }));
        expect(await runEslintScan(temp({ 'a.js': '' }), ['a.js'], exec as any)).toMatchObject({ ok: false, code: 'SCAN_NONZERO_EXIT' });
    });

    it('turns a result that points outside the tree into a failure, not into findings', async () => {
        const exec = jest.fn(async () => ({ error: null, stdout: output([{ filePath: '../../etc/passwd', messages: [msg()] }]), stderr: '' }));
        expect(await runEslintScan(temp({ 'a.js': '' }), ['a.js'], exec as any)).toMatchObject({ ok: false, code: 'SCAN_NON_CANONICAL_PATH' });
    });
});

describe('the runner knows both scanners', () => {
    it('registers ESLint next to Semgrep', () => {
        expect(listScannerIds().sort()).toEqual(['ESLINT', 'SEMGREP']);
        expect(getScanner('ESLINT')?.id).toBe('ESLINT');
        expect(getScanner('eslint')).toBeUndefined();
    });
});

// ── Live: the real image ─────────────────────────────────────────────────────
const imageAvailable = (() => {
    try {
        execFileSync('docker', ['image', 'inspect', ESLINT_IMAGE], { stdio: 'ignore', timeout: 20000 });
        return true;
    } catch {
        return false;
    }
})();

(imageAvailable ? describe : describe.skip)('LIVE: the prism-eslint image', () => {
    const repo = () => temp({
        'lib/a.js': 'const unused = 1;\nfunction f(a) {\n  if (a = 2) { debugger; }\n  return undefinedThing;\n}\nmodule.exports = { f };\n',
        'lib/b.ts': 'export const x: any = 1;\nlet y = 2;\n',
        'lib/clean.js': 'function ok(a) {\n  return a + 1;\n}\nmodule.exports = { ok };\n',
        'lib/broken.js': 'function ( {\n',
        'tool.py': 'print(1)\n',
        // A repository config that would crash the process if ESLint loaded it
        'eslint.config.js': 'throw new Error("the repository config must never be executed");\n',
        '.eslintrc.js': 'process.exit(7);\n',
    });

    it('lints the listed files with PRism\'s rules and never runs the repository\'s own config', async () => {
        const outcome = await runEslintScan(repo(), ['lib/a.js', 'lib/b.ts', 'lib/clean.js', 'lib/broken.js', 'tool.py', 'deleted.js']);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const byFile = Object.fromEntries(outcome.result.results.map((r: any) => [r.filePath, r.messages]));
        expect(Object.keys(byFile).sort()).toEqual(['lib/a.js', 'lib/b.ts', 'lib/broken.js', 'lib/clean.js']);
        expect(byFile['lib/a.js'].map((m: any) => m.ruleId).sort()).toEqual(['no-cond-assign', 'no-constant-condition', 'no-debugger', 'no-undef', 'no-unused-vars', 'no-unused-vars']);
        expect(byFile['lib/a.js'].find((m: any) => m.ruleId === 'no-undef')).toMatchObject({ line: 4, lines: '  return undefinedThing;' });
        expect(byFile['lib/b.ts'].map((m: any) => m.ruleId)).toContain('@typescript-eslint/no-explicit-any');
        expect(byFile['lib/b.ts'].find((m: any) => m.ruleId === 'prefer-const').fix).toEqual({ range: [25, 35], text: 'const y = 2;' });
        expect(byFile['lib/clean.js']).toEqual([]);
        expect(byFile['lib/broken.js']).toHaveLength(1);
        expect(byFile['lib/broken.js'][0]).toMatchObject({ fatal: true, ruleId: null });
        expect(outcome.result.version).toBe('9.17.0');
    }, 120000);

    it('does not touch the repository', async () => {
        const dir = repo();
        const before = fs.readdirSync(dir, { recursive: true }).map(String).sort();
        await runEslintScan(dir, undefined);
        expect(fs.readdirSync(dir, { recursive: true }).map(String).sort()).toEqual(before);
    }, 120000);
});
