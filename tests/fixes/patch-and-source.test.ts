/**
 * P0 correctness gate — items 1, 3, 4:
 * deterministic patch hashing, real source context for the fix model, no mock fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

vi.mock('ai', () => ({ generateObject: vi.fn() }));
vi.mock('@/lib/ai', () => ({ getFixModel: vi.fn(() => 'test-model') }));

import { generateObject } from 'ai';
import { sha256, applyLiteralEdit, generateDeterministicPatch } from '../../src/modules/fix/lib/diff';
import { buildSourceWindow, snippetMatchesSource, SourceWindowError } from '../../src/modules/fix/lib/source-window';
import { buildFixPrompt } from '../../src/modules/fix/lib/prompt';
import { generateFix } from '../../src/modules/fix/lib/generate';
import { FixProposal } from '../../src/modules/fix/lib/schema';

const proposalFor = (edits: FixProposal['edits']): FixProposal => ({
    findingId: 'f1', explanation: 'x', riskNotes: '', selfConfidence: 0.9, edits
});

describe('P0-1 sha256 and deterministic patch hash', () => {
    it('sha256 matches the reference implementation', () => {
        expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(sha256('héllo')).toBe(crypto.createHash('sha256').update(Buffer.from('héllo', 'utf-8')).digest('hex'));
    });

    it('diffSha256 is the hash of the unified diff and is stable across runs', () => {
        const base = { 'foo.ts': 'say hello\n' };
        const a = generateDeterministicPatch(proposalFor([{ path: 'foo.ts', find: 'hello', replace: 'world' }]), base);
        const b = generateDeterministicPatch(proposalFor([{ path: 'foo.ts', find: 'hello', replace: 'world' }]), base);

        expect(a.diffSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(a.diffSha256).toBe(sha256(a.unifiedDiff));
        expect(b.diffSha256).toBe(a.diffSha256);
        expect(b.unifiedDiff).toBe(a.unifiedDiff);
    });

    it('a different edit produces a different hash', () => {
        const base = { 'foo.ts': 'say hello\n' };
        const a = generateDeterministicPatch(proposalFor([{ path: 'foo.ts', find: 'hello', replace: 'world' }]), base);
        const b = generateDeterministicPatch(proposalFor([{ path: 'foo.ts', find: 'hello', replace: 'there' }]), base);
        expect(a.diffSha256).not.toBe(b.diffSha256);
    });

    it('baseBlobShas are git blob hashes of the original content', () => {
        const patch = generateDeterministicPatch(proposalFor([{ path: 'foo.ts', find: 'hello', replace: 'world' }]), { 'foo.ts': 'hello\n' });
        // `printf 'hello\n' | git hash-object --stdin`
        expect(patch.baseBlobShas['foo.ts']).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    });

    it('replacement text is literal: "$&", "$1", "$$" are not interpreted', () => {
        expect(applyLiteralEdit('price = cost;', 'cost', '"$&" + "$1" + "$$"')).toBe('price = "$&" + "$1" + "$$";');
        const patch = generateDeterministicPatch(
            proposalFor([{ path: 'a.js', find: 'x()', replace: "run('$&', '$$')" }]),
            { 'a.js': 'x()\n' }
        );
        expect(patch.unifiedDiff).toContain("+run('$&', '$$')");
    });
});

describe('P0-3 source window from the real file', () => {
    const file = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');

    it('returns verbatim text around the finding with no line numbers added', () => {
        const w = buildSourceWindow('src/a.js', file, 100, 101, { contextLines: 5 });
        expect(w.windowStartLine).toBe(95);
        expect(w.windowEndLine).toBe(106);
        expect(w.findingText).toBe('line 100\nline 101');
        expect(w.text.split('\n')[0]).toBe('line 95');
        expect(file.includes(w.text)).toBe(true);
    });

    it('clamps at file boundaries', () => {
        const w = buildSourceWindow('src/a.js', file, 2, 2, { contextLines: 10 });
        expect(w.windowStartLine).toBe(1);
        expect(w.windowEndLine).toBe(12);
    });

    it('is deterministic', () => {
        expect(buildSourceWindow('a.js', file, 50, 50)).toEqual(buildSourceWindow('a.js', file, 50, 50));
    });

    it('shrinks context to respect the size budget instead of sending the whole file', () => {
        const big = Array.from({ length: 2000 }, (_, i) => `const value${i} = ${'x'.repeat(80)};`).join('\n');
        const w = buildSourceWindow('big.js', big, 1000, 1000, { contextLines: 40, maxChars: 2000 });
        expect(w.text.length).toBeLessThanOrEqual(2000);
        expect(w.text).toContain('const value999 =');
        expect(w.windowEndLine - w.windowStartLine).toBeLessThan(80);
    });

    it('rejects finding lines that are not in the file', () => {
        expect(() => buildSourceWindow('a.js', 'one\ntwo', 5, 5)).toThrow(SourceWindowError);
        expect(() => buildSourceWindow('a.js', 'one\ntwo', 0, 1)).toThrow(SourceWindowError);
        expect(() => buildSourceWindow('a.js', 'one\ntwo', 2, 1)).toThrow(SourceWindowError);
    });

    it('detects when the fetched source is not the code that was scanned', () => {
        const w = buildSourceWindow('a.js', 'a();\nexec(cmd);\nb();', 2, 2);
        expect(snippetMatchesSource('exec(cmd);', w)).toBe(true);
        expect(snippetMatchesSource('  exec(cmd);\r\n', w)).toBe(true);
        expect(snippetMatchesSource('somethingElse();', w)).toBe(false);
        expect(snippetMatchesSource('requires login', w)).toBe(false);
    });
});

describe('P0-3 fix prompt carries real source', () => {
    const content = 'function getUser(id) {\n    return db.query("SELECT * FROM users WHERE id = " + id);\n}\n';
    const finding = { id: 'f1', message: 'SQL injection', ruleId: 'prism-sql-injection', filePath: 'lib/db.js', codeSnippet: 'ignored' };

    it('includes the verbatim source, the path and the line range', () => {
        const prompt = buildFixPrompt(finding, buildSourceWindow('lib/db.js', content, 2, 2), []);
        expect(prompt).toContain('    return db.query("SELECT * FROM users WHERE id = " + id);');
        expect(prompt).toContain('function getUser(id) {');
        expect(prompt).toContain('File: lib/db.js');
        expect(prompt).toContain('Lines: 2-2');
        expect(prompt).not.toContain('requires login');
    });

    it('an exact find string taken from the prompt source matches the file exactly once', () => {
        const window = buildSourceWindow('lib/db.js', content, 2, 2);
        const find = window.findingText;
        expect(content.split(find).length - 1).toBe(1);
    });
});

describe('P0-4 no mock fallback when the model fails', () => {
    const content = 'function getUser(id) {\n    return db.query("SELECT * FROM users WHERE id = " + id + " LIMIT 1");\n}\n';
    const finding = { id: 'f1', message: 'SQL injection', ruleId: 'prism-sql-injection', filePath: 'lib/db.js', startLine: 2, endLine: 2 };
    const window = buildSourceWindow('lib/db.js', content, 2, 2);

    beforeEach(() => vi.mocked(generateObject).mockReset());

    it('returns GENERATION_FAILED with no proposal and no patch', async () => {
        vi.mocked(generateObject).mockRejectedValueOnce(new Error('503 model overloaded'));

        const result = await generateFix(finding, window, [], { 'lib/db.js': content });

        expect(result.status).toBe('GENERATION_FAILED');
        expect(result.failureReason).toContain('503 model overloaded');
        expect(result.proposal).toBeUndefined();
        expect(result.patch).toBeUndefined();
    });

    it('does not produce a fix even when the old hardcoded mock would have matched the file', async () => {
        // This file content is exactly what the removed mock's `find` string targeted.
        vi.mocked(generateObject).mockRejectedValueOnce(new Error('network down'));
        const result = await generateFix(finding, window, [], { 'lib/db.js': content, 'db.js': content });
        expect(result.status).toBe('GENERATION_FAILED');
    });

    it('a real proposal against real source produces a patch', async () => {
        vi.mocked(generateObject).mockResolvedValueOnce({
            object: proposalFor([{
                path: 'lib/db.js',
                find: '    return db.query("SELECT * FROM users WHERE id = " + id + " LIMIT 1");',
                replace: '    return db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);'
            }]),
            usage: { totalTokens: 10 }
        } as any);

        const result = await generateFix(finding, window, [], { 'lib/db.js': content });
        expect(result.status).toBe('GENERATED');
        expect(result.patch!.diffSha256).toBe(sha256(result.patch!.unifiedDiff));
        expect(result.patch!.unifiedDiff).toContain('+    return db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);');
    });

    it('a proposal that edits a file outside the provided source is rejected', async () => {
        vi.mocked(generateObject).mockResolvedValueOnce({
            object: proposalFor([{ path: 'other.js', find: 'a', replace: 'b' }]),
            usage: {}
        } as any);
        const result = await generateFix(finding, window, [], { 'lib/db.js': content });
        expect(result.status).toBe('GUARD_REJECTED');
    });

    it('production fix-generation source contains no canned fix', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/modules/fix/lib/generate.ts'), 'utf8');
        expect(src).not.toMatch(/SELECT \* FROM users/);
        expect(src).not.toMatch(/fallback mock/i);
        const processFinding = fs.readFileSync(path.resolve(__dirname, '../../src/inngest/functions/process-finding.ts'), 'utf8');
        expect(processFinding).not.toContain('return "";');
        expect(processFinding).toContain('getFileAtRef(account.accessToken!, owner, repo, finding.filePath, headSha)');
    });
});
