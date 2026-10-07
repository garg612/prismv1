import { describe, expect, it } from 'vitest';
import { decideExecutionOutcome, NOT_APPLICABLE_REASONS } from '../../src/modules/validation/lib/exec-outcome';
import { buildReviewView } from '../../src/modules/review/lib/review-view';

const passed = { INSTALL: { status: 'PASSED' }, TEST: { status: 'PASSED' } };

describe('execution validation: a repository with nothing to run', () => {
    it('every known reason falls back to static validation, with fixed wording', () => {
        for (const code of Object.keys(NOT_APPLICABLE_REASONS)) {
            const decision = decideExecutionOutcome({ provider: 'e2b', notApplicable: { code, detail: 'runner text <b>ignored</b>' } });
            expect(decision.outcome).toBe('NOT_APPLICABLE');
            if (decision.outcome !== 'NOT_APPLICABLE') continue;
            expect(decision.reason).toMatch(/^Tests were not run: /);
            expect(decision.reason).not.toContain('runner text');
        }
    });

    it('an unrecognised or malformed reason is UNVERIFIED, never a fallback', () => {
        for (const notApplicable of [{ code: 'SANDBOX_DOWN' }, { code: 42 }, {}, { code: 'constructor' }, { code: null }]) {
            expect(decideExecutionOutcome({ provider: 'e2b', notApplicable } as any).outcome).toBe('UNVERIFIED');
        }
    });

    it('"nothing to run" alongside real results is contradictory and UNVERIFIED', () => {
        const mixed = { provider: 'e2b', notApplicable: { code: 'NO_SCRIPTS' }, baseline: passed, fixed: passed };
        expect(decideExecutionOutcome(mixed).outcome).toBe('UNVERIFIED');
    });

    it('a sandbox that ran but produced no evidence is still UNVERIFIED', () => {
        const none = { INSTALL: { status: 'PASSED' }, LINT: { status: 'UNAVAILABLE' }, BUILD: { status: 'SKIPPED' }, TEST: { status: 'UNAVAILABLE' } };
        expect(decideExecutionOutcome({ provider: 'e2b', baseline: none, fixed: none }).outcome).toBe('UNVERIFIED');
    });

    it('real passing results are still FIXED, and a regression still fails', () => {
        expect(decideExecutionOutcome({ provider: 'e2b', baseline: passed, fixed: passed }).outcome).toBe('FIXED');
        const broken = { INSTALL: { status: 'PASSED' }, TEST: { status: 'FAILED' } };
        expect(decideExecutionOutcome({ provider: 'e2b', baseline: passed, fixed: broken }).outcome).toBe('VALIDATION_FAILED');
    });
});

describe('review page: why tests were not run', () => {
    const staticRun = {
        tier: 'STATIC', kind: 'FIXED', status: 'COMPLETED',
        validationResults: [{ check: 'PATCH_APPLY', status: 'PASSED' }, { check: 'SYNTAX', status: 'PASSED' }, { check: 'SEMGREP_RESCAN', status: 'PASSED' }],
        findingDeltas: [{ delta: 'REMOVED', ruleId: 'rule-1' }],
    };
    const run = (executionRuns: any[]) => ({
        id: 'run-1', status: 'AWAITING_APPROVAL', headSha: 'a'.repeat(40),
        repository: { executionValidation: true },
        scanRuns: [{ kind: 'HEAD', source: 'SEMGREP', status: 'COMPLETED', scannedFiles: 3 }],
        findings: [{
            id: 'f-1', ruleId: 'rule-1', source: 'SEMGREP', severity: 'HIGH', category: 'SECURITY', filePath: 'a.js', startLine: 1, endLine: 1,
            message: 'm', codeSnippet: 'x', fingerprint: 'fp', triageDecision: 'SURFACE', isPreexisting: false, status: 'DETECTED', classifications: [],
            fixes: [{
                id: 'fix-1', status: 'READY', outcome: 'FIXED', explanation: 'e', applyAttempts: [],
                patch: { unifiedDiff: '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n', linesAdded: 1, linesRemoved: 1 },
                validationRuns: [staticRun, ...executionRuns],
            }],
        }],
    });

    it('nothing to run: the reason is shown and the fix can still be applied', () => {
        const summary = 'Tests were not run: this repository has no package.json, so there is no test, build or lint command to run.';
        const skipped = {
            tier: 'EXECUTION', kind: 'FIXED', status: 'COMPLETED',
            validationResults: ['INSTALL', 'LINT', 'BUILD', 'TEST'].map(check => ({ check, status: 'SKIPPED', summary })),
        };
        const fix = buildReviewView(run([skipped]), null).shown[0].fix!;

        expect(fix.executionNote).toBe(`${summary} This fix was checked by static analysis only.`);
        expect(fix.canDecide).toBe(true);
        expect(fix.execChecks.every(c => c.state === 'passed')).toBe(true);
        expect(fix.execChecks.map(c => c.label)).not.toContain('Tests');
    });

    it('tests that really ran are listed as checks, with no note', () => {
        const results = (status: string) => ['INSTALL', 'TEST'].map(check => ({ check, status }));
        const fix = buildReviewView(run([
            { tier: 'EXECUTION', kind: 'BASELINE', status: 'COMPLETED', validationResults: results('PASSED') },
            { tier: 'EXECUTION', kind: 'FIXED', status: 'COMPLETED', validationResults: results('PASSED') },
        ]), null).shown[0].fix!;

        expect(fix.executionNote).toBeNull();
        expect(fix.execChecks.find(c => c.label === 'Tests')).toMatchObject({ state: 'passed', detail: 'passes before and after the change' });
    });
});
