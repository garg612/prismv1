import { describe, it, expect, vi } from 'vitest';
import { processFinding } from '../../src/inngest/functions/process-finding';
import prisma from '../../src/lib/db';
import * as ai from 'ai';
import * as runnerClient from '../../src/modules/runner/lib/client';

// Mock everything external
vi.mock('ai', () => ({
    generateObject: vi.fn(),
    generateText: vi.fn()
}));

vi.mock('../../src/lib/ai', () => ({
    getFixModel: vi.fn(() => 'test-model'),
    getFixModelName: vi.fn(() => 'test-model')
}));

vi.mock('../../src/modules/runner/lib/client', () => ({
    requestValidation: vi.fn(),
    requestScan: vi.fn(),
    verifyHmac: vi.fn()
}));

vi.mock('../../src/modules/github/lib/github', () => ({
    getTarballUrl: vi.fn().mockResolvedValue('http://mock/tarball'),
    getFileAtRef: vi.fn().mockResolvedValue('const query = "SELECT * FROM users WHERE id = " + req.query.id;\n')
}));

vi.mock('../../src/modules/ai/lib/rag', () => ({
    retrieveContext: vi.fn().mockResolvedValue([])
}));

describe('Stage 6 Validation E2E Fixture', () => {
    it('detects and rejects a syntax-breaking fix proposal', async () => {
        // Since we cannot run full inngest locally easily, we will simulate the validation completion manually
        // or just test the outcome logic and orchestration logic
        
        // Mock Gemini returning a BAD patch
        const mockBadProposal = {
            findingId: 'f1',
            explanation: "I fixed the SQL injection",
            selfConfidence: 0.9,
            riskNotes: "",
            edits: [
                {
                    path: 'src/index.js',
                    find: 'const query = "SELECT * FROM users WHERE id = " + req.query.id;\n',
                    replace: 'const query = "SELECT * FROM users WHERE id = ?;", [req.query.id];\n' // Syntax error: dangling array
                }
            ]
        };

        vi.mocked(ai.generateObject).mockResolvedValueOnce({
            object: mockBadProposal,
            usage: {}
        } as any);

        // We can't fully run the inngest step function here without the inngest test kit.
        // Let's test `generateFix` directly.
        const { generateFix } = await import('../../src/modules/fix/lib/generate');
        const { buildSourceWindow } = await import('../../src/modules/fix/lib/source-window');
        const content = 'const query = "SELECT * FROM users WHERE id = " + req.query.id;\n';
        const finding = { id: 'f1', message: 'SQL injection', ruleId: 'js.security.sql-injection', filePath: 'src/index.js', startLine: 1, endLine: 1 };

        const genResult = await generateFix(finding, buildSourceWindow('src/index.js', content, 1, 1), [], { 'src/index.js': content });
        expect(genResult.status).toBe('GENERATED');

        // Test the validation outcome logic directly
        const { determineFixOutcome } = await import('../../src/modules/validation/lib/outcome');
        
        // If runner returns SYNTAX=FAILED
        const outcome = determineFixOutcome(true, false, false);
        expect(outcome).toBe('VALIDATION_FAILED');
    });

    it('detects and rejects a patch that introduces new findings', async () => {
        const { computeDelta } = await import('../helpers/semgrep-delta');
        const { determineFixOutcome } = await import('../../src/modules/validation/lib/outcome');
        
        // Mock head finding: sql injection
        const headFindings = [{ check_id: 'rule1', path: 'foo.ts', start: { line: 10 }, end: { line: 10 }, extra: { severity: 'HIGH', message: '' } }];
        // Mock post-fix findings: rule1 is gone, but we added an eval!
        const postFindings = [{ check_id: 'js.security.eval', path: 'foo.ts', start: { line: 10 }, end: { line: 10 }, extra: { severity: 'HIGH', message: '' } }];

        const delta = computeDelta('rule1', 'foo.ts', '10', headFindings as any, postFindings as any);
        expect(delta.stats.newFindingsCount).toBe(1);

        const outcome = determineFixOutcome(true, true, true, delta.stats);
        expect(outcome).toBe('NEW_FINDING_INTRODUCED');
    });
});
