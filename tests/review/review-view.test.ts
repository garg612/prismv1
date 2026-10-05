/**
 * The review page's wording is decided by buildReviewView. These tests pin the
 * contradictions the old page showed, using the shape of real records from PR #47.
 */
import { describe, it, expect } from 'vitest';
import { buildReviewView, parseUnifiedDiff, LatestRunInput } from '../../src/modules/review/lib/review-view';

const DIFF = `Index: b/lib/users.js
===================================================================
--- b/lib/users.js
+++ b/lib/users.js
@@ -11,7 +11,7 @@
     if (!id) {
         return null;
     }
-    return db.query("SELECT * FROM users WHERE id = " + id + " LIMIT 1");
+    return db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
 }

 module.exports = { listUsers, getUser };

`;

const classification = (over: Record<string, unknown> = {}) => ({
    modelName: 'prism-exp2-ensemble', modelVersion: 'prism-exp2-ensemble-v1.0', score: 0.200454,
    modelDecision: 'SURFACE', finalDecision: 'SURFACE', decisionSource: 'POLICY_SEVERITY_FLOOR',
    thresholdHigh: 0.6, thresholdLow: 0.25, isShadow: false, reasonText: null, createdAt: '2026-10-04T20:24:22Z', ...over
});

const staticRun = (over: Record<string, unknown> = {}) => ({
    tier: 'STATIC', kind: 'FIXED', status: 'COMPLETED',
    validationResults: [
        { check: 'PATCH_APPLY', status: 'PASSED' }, { check: 'SEMGREP_RESCAN', status: 'PASSED' }, { check: 'SYNTAX', status: 'PASSED' }
    ],
    findingDeltas: [{ delta: 'REMOVED', ruleId: 'prism-sql-injection' }],
    ...over
});

const fix = (over: Record<string, unknown> = {}) => ({
    id: 'fix-1', status: 'READY', outcome: 'FIXED', createdAt: '2026-10-04T20:25:00Z',
    explanation: 'Replaced string concatenation with a parameterized query.',
    patch: { unifiedDiff: DIFF, linesAdded: 1, linesRemoved: 1, baseBlobShas: { 'lib/users.js': 'abc' } },
    validationRuns: [staticRun()], applyAttempts: [], ...over
});

const finding = (over: Record<string, unknown> = {}) => ({
    id: 'finding-1', ruleId: 'prism-sql-injection', message: 'Potential SQL injection detected. Use parameterized queries.',
    filePath: 'lib/users.js', startLine: 14, severity: 'HIGH', category: 'SECURITY', fingerprint: 'fp-sqli',
    codeSnippet: '    return db.query("SELECT * FROM users WHERE id = " + id + " LIMIT 1");',
    isPreexisting: false, inChangedLines: true, triageDecision: 'SURFACE',
    classifications: [classification()], fixes: [fix()], ...over
});

const run = (over: Record<string, unknown> = {}) => ({
    id: 'run-1', status: 'AWAITING_APPROVAL', headSha: 'e841d962ed05', failureCode: null, failureMessage: null,
    repository: { executionValidation: false },
    scanRuns: [{ kind: 'HEAD', status: 'COMPLETED', scannedFiles: 1 }, { kind: 'BASE', status: 'COMPLETED', scannedFiles: 0 }],
    findings: [finding()], ...over
});

const applied = (mode = 'FIX_BRANCH_PR') => fix({
    status: 'IMPLEMENTED',
    applyAttempts: [{ status: 'SUCCEEDED', mode, resultCommitSha: '4ff6d7f0000', resultPrUrl: 'https://github.com/garg612/demo1/pull/48' }]
});
const appliedRun = (mode?: string, status = 'SUPERSEDED') => run({ status, findings: [finding({ fixes: [applied(mode)] })] });
const later = (over: Partial<LatestRunInput> = {}): LatestRunInput => ({ id: 'run-2', status: 'COMPLETED', headSha: 'db34c7a00000', findings: [], ...over });

const step = (view: ReturnType<typeof buildReviewView>, key: string) => view.steps.find(s => s.key === key)!;

describe('reported problem 1: "E2B Validation — Not Run"', () => {
    it('is not a pipeline step; it is explained once, as a setting, on the fix', () => {
        const view = buildReviewView(run(), null);
        expect(view.steps.map(s => s.key)).toEqual(['scan', 'triage', 'fix', 'decision', 'recheck']);
        expect(view.shown[0].fix!.executionNote).toMatch(/execution validation is turned off for this repository/);
        expect(view.shown[0].fix!.checks.some(c => c.state === 'notRun')).toBe(false);
    });

    it('when enabled and run, each execution check is listed and the note disappears', () => {
        const exec = (kind: string, test: string) => ({ tier: 'EXECUTION', kind, status: 'COMPLETED', validationResults: [{ check: 'INSTALL', status: 'PASSED' }, { check: 'TEST', status: test }] });
        const view = buildReviewView(run({
            repository: { executionValidation: true },
            findings: [finding({ fixes: [fix({ validationRuns: [staticRun(), exec('BASELINE', 'PASSED'), exec('FIXED', 'PASSED')] })] })]
        }), null);
        const f = view.shown[0].fix!;
        expect(f.executionNote).toBeNull();
        expect(f.checks.find(c => c.label === 'Tests')).toMatchObject({ state: 'passed' });
    });

    it('when enabled but execution could not start, the reason is shown', () => {
        const failed = { tier: 'EXECUTION', kind: 'FIXED', status: 'FAILED', validationResults: [{ check: 'INSTALL', status: 'UNAVAILABLE', summary: 'Execution validation did not run: EXECUTION_UNAVAILABLE: E2B_API_KEY is not configured' }] };
        const view = buildReviewView(run({
            repository: { executionValidation: true },
            findings: [finding({ fixes: [fix({ status: 'NOT_READY', outcome: 'UNVERIFIED', validationRuns: [staticRun(), failed] })] })]
        }), null);
        expect(view.shown[0].fix!.executionNote).toMatch(/E2B_API_KEY is not configured/);
        expect(view.shown[0].fix!.problem).toBe('The proposed change could not be verified.');
    });
});

describe('reported problem 2: "Fix Proposal" stayed unchecked after the fix was applied', () => {
    it('the fix step is done for a READY fix', () => {
        expect(step(buildReviewView(run(), null), 'fix')).toMatchObject({ state: 'done', detail: '1 fix generated and validated' });
    });

    it('and stays done once the fix is applied and the run is superseded', () => {
        const view = buildReviewView(appliedRun(), later());
        expect(step(view, 'fix').state).toBe('done');
        expect(step(view, 'decision')).toMatchObject({ state: 'done', detail: '1 accepted' });
    });

    it('and stays done when the fix is rejected', () => {
        const view = buildReviewView(run({ status: 'COMPLETED', findings: [finding({ fixes: [fix({ status: 'REJECTED' })] })] }), null);
        expect(step(view, 'fix').state).toBe('done');
        expect(step(view, 'decision')).toMatchObject({ state: 'done', detail: '1 rejected' });
        expect(view.headline.label).toBe('Fix rejected');
    });
});

describe('reported problem 3: "Revalidation — Checking PR…" spun forever', () => {
    it('confirmed: the later scan no longer finds the issue', () => {
        const view = buildReviewView(appliedRun(), later());
        expect(step(view, 'recheck')).toMatchObject({ state: 'done', detail: 'Confirmed: no longer detected in db34c7a' });
        expect(view.headline).toMatchObject({ label: 'Fixed and verified', tone: 'success' });
        expect(view.newerReview).toEqual({ runId: 'run-2', headSha: 'db34c7a' });
        expect(view.live).toBe(false);
        expect(view.shown[0].fix!.applied!.summary).toMatch(/has been merged/);
    });

    it('still detected: the later scan finds the same issue', () => {
        const view = buildReviewView(appliedRun(), later({ findings: [{ fingerprint: 'fp-sqli' }] }));
        expect(step(view, 'recheck')).toMatchObject({ state: 'failed', detail: 'Still detected in db34c7a' });
        expect(view.headline.tone).toBe('danger');
    });

    it('re-scan in progress: active, and the page keeps refreshing', () => {
        const view = buildReviewView(appliedRun(), later({ status: 'QUEUED' }));
        expect(step(view, 'recheck')).toMatchObject({ state: 'active', detail: 'Re-scanning commit db34c7a' });
        expect(view.live).toBe(true);
    });

    it('re-scan failed: says so instead of spinning', () => {
        expect(step(buildReviewView(appliedRun(), later({ status: 'FAILED' })), 'recheck').state).toBe('failed');
    });

    it('fix PR opened but not merged: waiting on the user, not a spinner, and not "Merged"', () => {
        const view = buildReviewView(appliedRun('FIX_BRANCH_PR', 'AWAITING_APPROVAL'), null);
        expect(step(view, 'recheck')).toMatchObject({ state: 'waiting' });
        expect(step(view, 'recheck').detail).toMatch(/Merge the fix PR #48/);
        expect(view.headline.label).toBe('Fix applied, not yet verified');
        expect(view.live).toBe(false);
        expect(view.shown[0].fix!.applied).toMatchObject({ linkLabel: 'Open fix PR #48' });
        expect(view.shown[0].fix!.applied!.summary).toMatch(/takes effect once that pull request is merged/);
    });

    it('direct commit: waits for the automatic re-scan', () => {
        const view = buildReviewView(appliedRun('DIRECT_COMMIT', 'AWAITING_APPROVAL'), null);
        expect(step(view, 'recheck').state).toBe('active');
        expect(view.shown[0].fix!.applied!.summary).toBe('Committed to the pull request branch as 4ff6d7f.');
    });
});

describe('triage explanation matches what actually decided', () => {
    it('severity floor: says the rule decided, and does not show a low score that would contradict it', () => {
        const f = buildReviewView(run(), null).shown[0];
        expect(f.reason).toBe('Shown because it is a high-severity security issue. PRism always shows these, whatever their risk score.');
        expect(f.isShown).toBe(true);
        // The stored score is 0.20, below the 0.60 bar. It did not decide anything, so it is not shown.
        expect(f.triage).toBeNull();
    });

    it('model decision: a plain, confident sentence and the score on a 0 to 100 scale', () => {
        const f = buildReviewView(run({ findings: [finding({ classifications: [classification({ decisionSource: 'MODEL', score: 0.71 })] })] }), null).shown[0];
        expect(f.reason).toBe('Shown because PRism rated it as likely to be a real problem.');
        expect(f.triage).toEqual({ score: 71, showFrom: 60 });
    });

    it('fallback: says no risk score was available, and shows no invented score', () => {
        const policy = classification({ modelName: 'policy-v0', modelVersion: 'N/A', score: 0, decisionSource: 'POLICY_FALLBACK', reasonText: 'HTTP error 503' });
        const f = buildReviewView(run({ findings: [finding({ classifications: [policy] })] }), null).shown[0];
        expect(f.reason).toBe("Shown by PRism's standard rules for high-severity security issues. No risk score was available for this one.");
        expect(f.triage).toBeNull();
    });

    it('both "not shown" outcomes of triage are presented as noise, never as "uncertain"', () => {
        const view = buildReviewView(run({ findings: [
            finding(),
            finding({ id: 'f2', triageDecision: 'SUPPRESS', fixes: [], classifications: [classification({ decisionSource: 'MODEL', score: 0.1, finalDecision: 'SUPPRESS' })] }),
            finding({ id: 'f3', triageDecision: 'UNCERTAIN', fixes: [], classifications: [classification({ decisionSource: 'MODEL', score: 0.4, finalDecision: 'UNCERTAIN' })] }),
        ] }), null);
        expect([view.shown.length, view.filtered.length]).toEqual([1, 2]);
        expect(step(view, 'triage').detail).toBe('1 shown, 2 filtered as noise');
        expect(view.stats.find(s => s.key === 'hidden')).toMatchObject({ label: 'Filtered as noise', value: 2 });
        for (const f of view.filtered) {
            expect(f.reason).toBe('Filtered out as noise: PRism rated it as unlikely to be a real problem.');
            expect(f.isShown).toBe(false);
            expect(f.canUnsuppress).toBe(true);
            expect(f.triage!.score).toBeLessThan(f.triage!.showFrom);
        }
        expect(JSON.stringify(view)).not.toMatch(/uncertain/i);
    });
});

describe('the risk score never contradicts where the issue is placed', () => {
    const scored = (decision: string, score: number, source = 'MODEL') =>
        finding({ triageDecision: decision, fixes: [], classifications: [classification({ decisionSource: source, score, finalDecision: decision })] });

    it('a shown issue only carries a score at or above the bar', () => {
        const view = buildReviewView(run({ findings: [scored('SURFACE', 0.71)] }), null);
        expect(view.shown[0].triage).toEqual({ score: 71, showFrom: 60 });
    });

    it('a filtered issue only carries a score below the bar', () => {
        const view = buildReviewView(run({ findings: [scored('SUPPRESS', 0.1), scored('UNCERTAIN', 0.35)].map((f, i) => ({ ...f, id: 'f' + i, fingerprint: 'fp' + i })) }), null);
        expect(view.filtered.map(f => f.triage)).toEqual([{ score: 10, showFrom: 60 }, { score: 35, showFrom: 60 }]);
    });

    it('hides the score whenever something other than the score decided', () => {
        for (const [decision, score, source] of [['SURFACE', 0.2, 'POLICY_SEVERITY_FLOOR'], ['SURFACE', 0.1, 'OVERRIDE'], ['SUPPRESS', 0.9, 'POLICY'], ['SURFACE', 0.3, 'MODEL']] as const) {
            const view = buildReviewView(run({ findings: [scored(decision, score, source)] }), null);
            const card = [...view.shown, ...view.filtered][0];
            expect(card.triage).toBeNull();
        }
    });

    it('uses the bar of the model that scored the issue', () => {
        const eslint = finding({ source: 'ESLINT', triageDecision: 'SURFACE', fixes: [], classifications: [classification({ decisionSource: 'MODEL', score: 0.5633, thresholdHigh: 0.505, thresholdLow: 0.505 })] });
        expect(buildReviewView(run({ findings: [eslint] }), null).shown[0].triage).toEqual({ score: 56, showFrom: 51 });
    });
});

describe('other states', () => {
    it('needs a decision', () => {
        const view = buildReviewView(run(), null);
        expect(view.headline).toMatchObject({ label: 'Needs your decision', tone: 'warning' });
        expect(step(view, 'decision').state).toBe('waiting');
        expect(view.shown[0].fix!.canDecide).toBe(true);
    });

    it('a READY fix on a superseded run cannot be applied from this page', () => {
        const view = buildReviewView(run({ status: 'SUPERSEDED' }), later({ findings: [{ fingerprint: 'fp-sqli' }] }));
        expect(view.shown[0].fix!.canDecide).toBe(false);
        expect(view.shown[0].fix!.decisionBlockedReason).toMatch(/older commit/);
        expect(view.headline.label).toBe('Replaced by a newer review');
    });

    it('clean scan', () => {
        const view = buildReviewView(run({ status: 'COMPLETED', findings: [] }), null);
        expect(view.headline).toMatchObject({ label: 'No issues found', tone: 'success' });
        // Stages that did not happen are left out; the bar ends with how the review turned out.
        expect(view.steps.map(s => [s.key, s.state, s.detail])).toEqual([['scan', 'done', '1 file scanned, 0 issues found'], ['result', 'done', 'No issues found']]);
    });

    it('failed scan is never presented as clean', () => {
        const view = buildReviewView(run({
            status: 'FAILED', failureCode: 'HEAD_SCAN_TOOL_ERRORS', failureMessage: 'HEAD scan did not complete: Semgrep reported 1 error(s)',
            scanRuns: [{ kind: 'HEAD', status: 'FAILED', toolErrors: { code: 'SCAN_TOOL_ERRORS' } }], findings: []
        }), null);
        expect(view.headline).toMatchObject({ label: 'Analysis did not complete', tone: 'danger' });
        expect(step(view, 'scan')).toMatchObject({ state: 'failed', detail: 'The head scan did not complete (SCAN_TOOL_ERRORS)' });
        expect(view.headline.label).not.toMatch(/No issues/);
    });

    it('in progress', () => {
        const view = buildReviewView(run({ status: 'QUEUED', scanRuns: [{ kind: 'HEAD', status: 'RUNNING' }], findings: [] }), null);
        expect(view.headline.label).toBe('Analysis in progress');
        expect(step(view, 'scan').state).toBe('active');
        expect(view.live).toBe(true);
    });

    it('no fix could be generated: short reason, attempts counted once, raw provider text not shown', () => {
        const failed = (id: string) => fix({ id, status: 'NOT_READY', outcome: null, patch: null, validationRuns: [], explanation: 'No fix was generated. LLM generation failed: You exceeded your current quota, please check https://ai.google.dev/...' });
        const view = buildReviewView(run({ status: 'COMPLETED', findings: [finding({ fixes: [failed('a'), failed('b')] })] }), null);
        expect(step(view, 'fix')).toMatchObject({ state: 'failed', detail: 'No fix could be generated' });
        expect(view.shown[0].fix!.problem).toBe("No fix could be generated: the AI model's usage limit was reached. (2 attempts)");
        expect(view.shown[0].failedAttempts).toEqual([]);
        expect(view.headline.label).toBe('Issues found, no automatic fix');
    });

    it('an earlier failed attempt is listed only when a later one succeeded', () => {
        const failed = fix({ id: 'old', status: 'NOT_READY', outcome: null, patch: null, validationRuns: [], createdAt: '2026-10-04T20:20:00Z', explanation: 'LLM generation failed: This model is currently experiencing high demand.' });
        const view = buildReviewView(run({ findings: [finding({ fixes: [failed, fix()] })] }), null);
        expect(view.shown[0].fix!.statusLabel).toBe('Ready to apply');
        expect(view.shown[0].failedAttempts).toEqual([{ id: 'old', reason: 'No fix could be generated: the AI model was temporarily unavailable.' }]);
    });

    it('a fix that introduces a new issue says which one', () => {
        const bad = staticRun({ findingDeltas: [{ delta: 'REMOVED', ruleId: 'prism-sql-injection' }, { delta: 'ADDED', ruleId: 'prism-command-injection' }] });
        const view = buildReviewView(run({ status: 'COMPLETED', findings: [finding({ fixes: [fix({ status: 'NOT_READY', outcome: 'NEW_FINDING_INTRODUCED', validationRuns: [bad] })] })] }), null);
        const f = view.shown[0].fix!;
        expect(f.problem).toBe('The proposed change introduced a new issue.');
        expect(f.checks.find(c => c.label === 'No new issues introduced')).toMatchObject({ state: 'failed', detail: 'introduces prism-command-injection' });
    });
});

describe('diff rendering', () => {
    it('drops the Index/====/file header noise and classifies lines', () => {
        const lines = parseUnifiedDiff(DIFF);
        expect(lines.some(l => /^Index:|^=+$|^--- |^\+\+\+ /.test(l.text))).toBe(false);
        expect(lines[0]).toEqual({ kind: 'hunk', text: '@@ -11,7 +11,7 @@' });
        expect(lines.filter(l => l.kind === 'add')).toHaveLength(1);
        expect(lines.filter(l => l.kind === 'del')).toHaveLength(1);
        expect(lines[lines.length - 1].text).toBe(' module.exports = { listUsers, getUser };');
    });

    it('handles a missing patch', () => {
        expect(parseUnifiedDiff(null)).toEqual([]);
    });
});

describe('review page: saved answers, summary counts and un-hiding', () => {
    it('shows the answer the user already gave, using their latest one', () => {
        const none = buildReviewView(run(), null);
        expect(none.shown[0].myVerdict).toBeNull();

        const answered = buildReviewView(run({ findings: [finding({ feedback: [
            { kind: 'TRUE_POSITIVE', createdAt: '2026-10-04T20:30:00Z' },
            { kind: 'FALSE_POSITIVE', createdAt: '2026-10-04T20:40:00Z' },
        ] })] }), null);
        expect(answered.shown[0].myVerdict).toBe('FALSE_ALARM');
    });

    it('does not show an applied fix as an answer the user gave', () => {
        const view = buildReviewView(run({ findings: [finding({ feedback: [{ kind: 'FIX_ACCEPTED', createdAt: '2026-10-04T20:30:00Z' }] })] }), null);
        expect(view.shown[0].myVerdict).toBeNull();
    });

    it('summary counts equal the cards on the page', () => {
        const view = buildReviewView(run({ findings: [
            finding(),
            finding({ id: 'finding-2', fingerprint: 'fp-2', triageDecision: 'SUPPRESS', fixes: [] }),
            finding({ id: 'finding-3', fingerprint: 'fp-3', fixes: [fix({ id: 'fix-3', status: 'IMPLEMENTED' })] }),
        ] }), null);
        const stat = (key: string) => view.stats.find(s => s.key === key)?.value;
        expect(stat('shown')).toBe(view.shown.length);
        expect(stat('hidden')).toBe(view.filtered.length);
        expect(stat('waiting')).toBe(1);
        expect(stat('applied')).toBe(1);
        expect(view.stats.some(s => s.key === 'logic')).toBe(false);
    });

    it('does not count a fix as waiting once the review can no longer be decided', () => {
        const view = buildReviewView(run({ status: 'SUPERSEDED' }), null);
        expect(view.stats.find(s => s.key === 'waiting')?.value).toBe(0);
    });

    it('offers "Show this issue" only on a finished, current review', () => {
        const hidden = finding({ triageDecision: 'SUPPRESS', fixes: [] });
        expect(buildReviewView(run({ status: 'COMPLETED', findings: [hidden] }), null).filtered[0].canUnsuppress).toBe(true);
        expect(buildReviewView(run({ status: 'SUPERSEDED', findings: [hidden] }), null).filtered[0].canUnsuppress).toBe(false);
        expect(buildReviewView(run({ status: 'FIXING', findings: [hidden] }), null).filtered[0].canUnsuppress).toBe(false);
    });

    it('explains an issue the user un-hid', () => {
        const unhidden = finding({ fixes: [], classifications: [
            classification({ decisionSource: 'MODEL', finalDecision: 'SUPPRESS', createdAt: '2026-10-04T20:24:22Z' }),
            classification({ modelName: 'policy-override', decisionSource: 'OVERRIDE', finalDecision: 'SURFACE', createdAt: '2026-10-04T21:00:00Z' }),
        ] });
        expect(buildReviewView(run({ status: 'COMPLETED', findings: [unhidden] }), null).shown[0].reason).toBe('Shown because you chose to bring it back.');
    });

    it('reports a duration only when both ends were recorded and the review has finished', () => {
        expect(buildReviewView(run(), null).durationMs).toBeNull();
        expect(buildReviewView(run({ startedAt: '2026-10-04T20:00:00Z', finishedAt: '2026-10-04T20:01:12Z' }), null).durationMs).toBe(72000);
        expect(buildReviewView(run({ status: 'FIXING', startedAt: '2026-10-04T20:00:00Z', finishedAt: null }), null).durationMs).toBeNull();
    });

    it('gives each snippet its real first line number and names the scanner', () => {
        const view = buildReviewView(run({ findings: [finding({ source: 'SEMGREP' })] }), null);
        expect(view.shown[0].line).toBe(14);
        expect(view.shown[0].scanner).toBe('Semgrep');
    });
});

describe('review page: a review that stopped progressing', () => {
    const now = Date.parse('2026-10-04T23:30:00Z');

    it('is reported as not completed and stops refreshing', () => {
        const view = buildReviewView(run({ status: 'QUEUED', updatedAt: '2026-10-04T20:00:00Z', scanRuns: [], findings: [] }), null, now);
        expect(view.headline.label).toBe('Analysis did not complete');
        expect(view.headline.detail).toMatch(/stopped making progress/);
        expect(view.live).toBe(false);
        expect(view.steps[0].state).toBe('failed');
    });

    it('is still in progress while it keeps updating', () => {
        const view = buildReviewView(run({ status: 'QUEUED', updatedAt: '2026-10-04T23:25:00Z', scanRuns: [], findings: [] }), null, now);
        expect(view.headline.label).toBe('Analysis in progress');
        expect(view.live).toBe(true);
    });
});

describe('review page: while a fix is being applied', () => {
    it('says so in the headline instead of claiming there is no automatic fix', () => {
        const view = buildReviewView(run({ findings: [finding({ fixes: [fix({ status: 'IMPLEMENTING' })] })] }), null);
        expect(view.headline.label).toBe('Applying the fix');
        expect(view.steps.find(s => s.key === 'decision')?.state).toBe('active');
        expect(view.live).toBe(true);
    });
});

describe('review page: a re-check after a fix was applied', () => {
    const earlier = (over: Record<string, unknown> = {}) => ({
        id: 'run-0', headSha: '11bf99aaaaaa', updatedAt: '2026-10-04T20:00:00Z',
        findings: [{ source: 'SEMGREP', fingerprint: 'fp-sqli', triageDecision: 'SURFACE', fixes: [{ status: 'IMPLEMENTED', applyAttempts: [{ status: 'SUCCEEDED', mode: 'FIX_BRANCH_PR', resultPrUrl: 'https://github.com/o/r/pull/77' }] }] }],
        ...over,
    });
    const rescan = (over: Record<string, unknown> = {}) => run({
        id: 'run-1', status: 'COMPLETED', headSha: '91e1dfc00000',
        scanRuns: [{ kind: 'HEAD', status: 'COMPLETED', scannedFiles: 4 }, { kind: 'BASE', status: 'COMPLETED', scannedFiles: 1 }],
        findings: [], ...over,
    });
    const NOW = Date.parse('2026-10-04T21:00:00Z');

    it('tells the pull request story instead of three empty stages', () => {
        const view = buildReviewView(rescan(), null, NOW, [earlier()]);
        expect(view.headline).toMatchObject({ label: 'Fixed and verified', tone: 'success' });
        expect(view.headline.detail).toBe('The fix applied after the review of 11bf99a is confirmed: a re-scan of 91e1dfc no longer finds the issue.');
        expect(view.steps.map(s => [s.key, s.state, s.detail])).toEqual([
            ['found', 'done', '1 issue in commit 11bf99a'],
            ['applied', 'done', 'Merged through fix PR #77'],
            ['rescan', 'done', '4 files scanned in 91e1dfc'],
            ['verified', 'done', 'No longer detected in 91e1dfc'],
        ]);
        expect(view.stats.map(s => [s.key, s.value])).toEqual([['found', 1], ['applied', 1], ['still', 0], ['hidden', 0]]);
        expect(view.earlierReview).toEqual({ runId: 'run-0', headSha: '11bf99a' });
    });

    it('is not affected by an uncertain issue or by AI suggestions on the re-scan', () => {
        const view = buildReviewView(rescan({ findings: [
            finding({ id: 'u', fingerprint: 'fp-log', triageDecision: 'UNCERTAIN', fixes: [] }),
            finding({ id: 'l', source: 'CUSTOM', fingerprint: 'fp-logic', triageDecision: null, fixes: [] }),
        ] }), null, NOW, [earlier()]);
        expect(view.headline.label).toBe('Fixed and verified');
        expect(view.steps.map(s => s.key)).toEqual(['found', 'applied', 'rescan', 'verified']);
    });

    it('does not claim verification while the re-scan is still running', () => {
        const view = buildReviewView(rescan({ status: 'QUEUED', updatedAt: '2026-10-04T20:59:00Z', scanRuns: [] }), null, NOW, [earlier()]);
        expect(view.headline).toMatchObject({ label: 'Re-checking after the fix', tone: 'info' });
        expect(view.steps.map(s => [s.key, s.state])).toEqual([['found', 'done'], ['applied', 'done'], ['rescan', 'active'], ['verified', 'todo']]);
    });

    it('says "not verified" when the fixed issue is still reported, even as uncertain', () => {
        const view = buildReviewView(rescan({ findings: [finding({ fingerprint: 'fp-sqli', triageDecision: 'UNCERTAIN', fixes: [] })] }), null, NOW, [earlier()]);
        expect(view.headline).toMatchObject({ label: 'Not verified', tone: 'danger' });
        expect(view.steps.find(s => s.key === 'verified')).toMatchObject({ state: 'failed', detail: '1 issue still detected in 91e1dfc' });
        expect(view.stats.find(s => s.key === 'still')?.value).toBe(1);
    });

    it('keeps the normal stages when the re-scan has an issue to act on', () => {
        const view = buildReviewView(rescan({ status: 'AWAITING_APPROVAL', findings: [finding({ fingerprint: 'fp-new' })] }), null, NOW, [earlier()]);
        expect(view.headline.label).toBe('Needs your decision');
        expect(view.steps.map(s => s.key)).toEqual(['scan', 'triage', 'fix', 'decision', 'recheck']);
        expect(view.earlierReview).toBeNull();
    });

    it('is a plain clean review when the earlier review applied nothing', () => {
        const noFix = earlier({ findings: [{ source: 'SEMGREP', fingerprint: 'fp-sqli', triageDecision: 'SURFACE', fixes: [{ status: 'REJECTED' }] }] });
        const view = buildReviewView(rescan(), null, NOW, [noFix]);
        expect(view.headline.label).toBe('No issues found');
        expect(view.steps.map(s => s.key)).toEqual(['scan', 'result']);
    });

    it('counts several fixes and names no single fix PR when there were several', () => {
        const two = earlier({ findings: [
            { source: 'SEMGREP', fingerprint: 'a', triageDecision: 'SURFACE', fixes: [{ status: 'IMPLEMENTED', applyAttempts: [{ status: 'SUCCEEDED', resultPrUrl: 'https://github.com/o/r/pull/77' }] }] },
            { source: 'SEMGREP', fingerprint: 'b', triageDecision: 'SURFACE', fixes: [{ status: 'IMPLEMENTED', applyAttempts: [{ status: 'SUCCEEDED', resultPrUrl: 'https://github.com/o/r/pull/78' }] }] },
        ] });
        const view = buildReviewView(rescan(), null, NOW, [two]);
        expect(view.headline.detail).toMatch(/^All 2 fixes applied .* are confirmed/);
        expect(view.steps[1]).toMatchObject({ label: 'Fixes applied', detail: '2 fixes applied' });
    });
});
