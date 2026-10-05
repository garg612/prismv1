import { describe, it, expect } from 'vitest';
import { runGuards, GuardContext } from '../../src/modules/fix/lib/guards';
import { scanForSecrets } from '../../src/modules/fix/lib/secret-scan';
import { generateDeterministicPatch } from '../../src/modules/fix/lib/diff';
import { computeDelta, hashSemgrepMatch } from '../helpers/semgrep-delta';
import { FixProposal } from '../../src/modules/fix/lib/schema';
import crypto from 'crypto';

describe('Stage 6 Guards', () => {
    it('rejects path traversal', () => {
        const proposal: FixProposal = {
            findingId: '123', explanation: '', riskNotes: '', selfConfidence: 0.9,
            edits: [{ path: '../foo.ts', find: 'a', replace: 'b' }]
        };
        const res = runGuards(proposal, { baseFileContents: { '../foo.ts': 'a' }, findingPath: '', findingStartLine: 1, findingEndLine: 1 });
        expect(res.passed).toBe(false);
        expect(res.reason).toContain('traversal');
    });

    it('rejects forbidden paths', () => {
        const proposal: FixProposal = {
            findingId: '123', explanation: '', riskNotes: '', selfConfidence: 0.9,
            edits: [{ path: '.github/workflows/ci.yml', find: 'a', replace: 'b' }]
        };
        const res = runGuards(proposal, { baseFileContents: { '.github/workflows/ci.yml': 'a' }, findingPath: '', findingStartLine: 1, findingEndLine: 1 });
        expect(res.passed).toBe(false);
        expect(res.reason).toContain('Forbidden');
    });

    it('rejects exact match failure', () => {
        const proposal: FixProposal = {
            findingId: '123', explanation: '', riskNotes: '', selfConfidence: 0.9,
            edits: [{ path: 'foo.ts', find: 'abc', replace: 'def' }]
        };
        const res = runGuards(proposal, { baseFileContents: { 'foo.ts': 'abcd \n abc' }, findingPath: '', findingStartLine: 1, findingEndLine: 1 });
        expect(res.passed).toBe(false);
        expect(res.reason).toContain('occurs 2 times');
    });

    it('passes valid edit', () => {
        const proposal: FixProposal = {
            findingId: '123', explanation: '', riskNotes: '', selfConfidence: 0.9,
            edits: [{ path: 'foo.ts', find: 'abc', replace: 'def' }]
        };
        const res = runGuards(proposal, { baseFileContents: { 'foo.ts': 'abc' }, findingPath: '', findingStartLine: 1, findingEndLine: 1 });
        expect(res.passed).toBe(true);
    });
});

describe('Stage 6 Secret Scan', () => {
    it('detects AWS keys', () => {
        const res = scanForSecrets('const key = "AKIAIOSFODNN7EXAMPLE";');
        expect(res.length).toBeGreaterThan(0);
        expect(res[0].type).toBe('AWS Access Key');
    });

    it('detects generic secrets', () => {
        const res = scanForSecrets('const token = "12345678901234567890";');
        expect(res.length).toBeGreaterThan(0);
        expect(res[0].type).toBe('Generic Secret');
    });

    it('passes normal code', () => {
        const res = scanForSecrets('const message = "Hello, world!";');
        expect(res.length).toBe(0);
    });
});

describe('Stage 6 Diff', () => {
    it('generates deterministic diff', () => {
        const proposal: FixProposal = {
            findingId: '123', explanation: '', riskNotes: '', selfConfidence: 0.9,
            edits: [{ path: 'foo.ts', find: 'hello', replace: 'world' }]
        };
        const patch = generateDeterministicPatch(proposal, { 'foo.ts': 'say hello\n' });
        expect(patch.filesChanged).toBe(1);
        expect(patch.linesAdded).toBe(1);
        expect(patch.linesRemoved).toBe(1);
        expect(patch.unifiedDiff).toContain('-say hello');
        expect(patch.unifiedDiff).toContain('+say world');
    });
});

describe('Stage 6 Delta', () => {
    it('determines FIXED when finding is removed', () => {
        const headFindings = [{ check_id: 'rule1', path: 'foo.ts', start: { line: 10 }, end: { line: 10 }, extra: { severity: 'HIGH', message: '', lines: 'var a = 1;' } }];
        const postFindings: any[] = [];
        
        const result = computeDelta('rule1', 'foo.ts', 'fp-1', headFindings as any, postFindings as any);
        // Assuming generateFingerprint for 'rule1', 'foo.ts', 'var a = 1;' is 'hash'.
        // Wait, the target finding hash must match exactly what `hashSemgrepMatch` computes for headFindings.
        // Let's compute it:
        const fp = hashSemgrepMatch(headFindings[0]);
        
        const result2 = computeDelta('rule1', 'foo.ts', fp, headFindings as any, postFindings as any);
        expect(result2.stats.targetFindingStatus).toBe('REMOVED');
        expect(result2.stats.newFindingsCount).toBe(0);
        expect(result2.stats.partiallyFixed).toBe(false);
    });

    it('determines ADDED when new finding introduced', () => {
        const headFindings = [{ check_id: 'rule1', path: 'foo.ts', start: { line: 10 }, end: { line: 10 }, extra: { severity: 'HIGH', message: '', lines: 'var a = 1;' } }];
        const postFindings = [
            { check_id: 'rule2', path: 'foo.ts', start: { line: 15 }, end: { line: 15 }, extra: { severity: 'HIGH', message: '', lines: 'var b = 2;' } }
        ];
        
        const fp = hashSemgrepMatch(headFindings[0]);

        const result = computeDelta('rule1', 'foo.ts', fp, headFindings as any, postFindings as any);
        expect(result.stats.targetFindingStatus).toBe('REMOVED');
        expect(result.stats.newFindingsCount).toBe(1);
        expect(result.deltas.find(d => d.delta === 'ADDED')?.ruleId).toBe('rule2');
    });

    it('determines UNCHANGED when lines shift but code is same', () => {
        const headFindings = [{ check_id: 'rule1', path: 'foo.ts', start: { line: 10 }, end: { line: 10 }, extra: { severity: 'HIGH', message: '', lines: 'var a = 1;' } }];
        const postFindings = [{ check_id: 'rule1', path: 'foo.ts', start: { line: 15 }, end: { line: 15 }, extra: { severity: 'HIGH', message: '', lines: 'var a = 1;' } }];
        
        const fp = hashSemgrepMatch(headFindings[0]);

        const result = computeDelta('rule1', 'foo.ts', fp, headFindings as any, postFindings as any);
        expect(result.stats.targetFindingStatus).toBe('UNCHANGED');
        expect(result.stats.newFindingsCount).toBe(0);
    });

    it('handles multisets correctly', () => {
        // Two identical findings in the same file
        const headFindings = [
            { check_id: 'rule1', path: 'foo.ts', start: { line: 10 }, end: { line: 10 }, extra: { severity: 'HIGH', message: '', lines: 'var a = 1;' } },
            { check_id: 'rule1', path: 'foo.ts', start: { line: 20 }, end: { line: 20 }, extra: { severity: 'HIGH', message: '', lines: 'var a = 1;' } }
        ];
        // One is removed
        const postFindings = [
            { check_id: 'rule1', path: 'foo.ts', start: { line: 20 }, end: { line: 20 }, extra: { severity: 'HIGH', message: '', lines: 'var a = 1;' } }
        ];
        
        const fp = hashSemgrepMatch(headFindings[0]);

        const result = computeDelta('rule1', 'foo.ts', fp, headFindings as any, postFindings as any);
        // One occurrence fewer: this finding is fixed. The remaining twin is a separate finding.
        expect(result.stats.targetFindingStatus).toBe('REMOVED');
        expect(result.stats.partiallyFixed).toBe(false);
        expect(result.stats.newFindingsCount).toBe(0);

        // Nothing removed: both twins still reported, so the fix did not work.
        const unchanged = computeDelta('rule1', 'foo.ts', fp, headFindings as any, headFindings as any);
        expect(unchanged.stats.targetFindingStatus).toBe('UNCHANGED');
    });
});
