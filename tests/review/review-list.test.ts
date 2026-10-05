/**
 * The reviews list shows one row per pull request. The newest review of a pull request is
 * usually a re-scan that finds nothing, so the row must tell what happened across all of the
 * pull request's reviews, not repeat the re-scan's zeros.
 */
import { describe, it, expect } from 'vitest';
import { buildReviewList, ReviewListRunInput } from '../../src/modules/review/lib/review-list';

let seq = 0;
const run = (over: Partial<ReviewListRunInput> = {}): ReviewListRunInput => ({
    id: `run${++seq}`, status: 'COMPLETED', headSha: 'abcdef1234567890', updatedAt: '2026-10-01T10:00:00Z',
    pullRequest: { id: 'pr1', number: 7, title: 'Add helpers', url: 'https://github.com/o/r/pull/7' },
    repository: { owner: 'o', name: 'r' }, findings: [], ...over,
});
const shown = (fingerprint: string, ...fixStatuses: string[]) => ({ source: 'SEMGREP', fingerprint, occurrence: 1, triageDecision: 'SURFACE', fixes: fixStatuses.map(status => ({ status })) });
const logic = (fingerprint = 'l1') => ({ source: 'CUSTOM', fingerprint, occurrence: 1, triageDecision: null, fixes: [] });
const NOW = Date.parse('2026-10-01T10:30:00Z');
const list = (runs: ReviewListRunInput[]) => buildReviewList(runs, NOW);

describe('buildReviewList', () => {
    it('returns nothing for an account without reviews', () => {
        expect(list([])).toEqual([]);
    });

    it('labels a clean pull request', () => {
        const [item] = list([run()]);
        expect(item).toMatchObject({ label: 'No issues', tone: 'success', group: 'clean', headSha: 'abcdef1', repository: 'o/r' });
        expect(item.counts).toEqual({ found: 0, fixed: 0, toDecide: 0, open: 0 });
    });

    it('tells the story of the pull request when the newest review is a clean re-scan', () => {
        const [item] = list([
            run({ id: 'first', status: 'SUPERSEDED', headSha: '1111111aaaa', updatedAt: '2026-10-01T09:00:00Z', findings: [shown('sqli', 'IMPLEMENTED'), shown('cmd', 'IMPLEMENTED')] }),
            run({ id: 'rescan', status: 'COMPLETED', headSha: '2222222bbbb', updatedAt: '2026-10-01T10:00:00Z', findings: [] }),
        ]);
        expect(item.runId).toBe('rescan');
        expect(item).toMatchObject({ label: 'Fixed and verified', tone: 'success', group: 'clean' });
        expect(item.counts).toEqual({ found: 2, fixed: 2, toDecide: 0, open: 0 });
        expect(item.earlier).toEqual([expect.objectContaining({ runId: 'first', label: '2 issues found, 2 fixes applied' })]);
    });

    it('counts an issue seen on several reviews of the pull request once', () => {
        const [item] = list([
            run({ status: 'SUPERSEDED', updatedAt: '2026-10-01T08:00:00Z', findings: [shown('sqli', 'NOT_READY')] }),
            run({ status: 'SUPERSEDED', updatedAt: '2026-10-01T09:00:00Z', findings: [shown('sqli', 'IMPLEMENTED')] }),
            run({ status: 'COMPLETED', updatedAt: '2026-10-01T10:00:00Z' }),
        ]);
        expect(item.counts).toMatchObject({ found: 1, fixed: 1, open: 0 });
    });

    it('shows what is still open when the re-scan still finds an issue', () => {
        const [item] = list([
            run({ status: 'SUPERSEDED', updatedAt: '2026-10-01T09:00:00Z', findings: [shown('a', 'IMPLEMENTED'), shown('b', 'NOT_READY')] }),
            run({ status: 'COMPLETED', updatedAt: '2026-10-01T10:00:00Z', findings: [shown('b', 'NOT_READY')] }),
        ]);
        expect(item).toMatchObject({ label: 'Issues found', group: 'issues' });
        expect(item.counts).toEqual({ found: 2, fixed: 1, toDecide: 0, open: 1 });
    });

    it('says "resolved" when an issue disappeared without an applied fix', () => {
        const [item] = list([
            run({ status: 'SUPERSEDED', updatedAt: '2026-10-01T09:00:00Z', findings: [shown('a', 'REJECTED')] }),
            run({ status: 'COMPLETED', updatedAt: '2026-10-01T10:00:00Z' }),
        ]);
        expect(item).toMatchObject({ label: 'Resolved', tone: 'success' });
        expect(item.counts).toMatchObject({ found: 1, fixed: 0, open: 0 });
    });

    it('asks for a decision only while the current review is awaiting approval', () => {
        const waiting = list([run({ status: 'AWAITING_APPROVAL', findings: [shown('a', 'READY'), shown('b', 'IMPLEMENT_FAILED')] })])[0];
        expect(waiting).toMatchObject({ label: 'Needs your decision', group: 'decision' });
        expect(waiting.counts).toMatchObject({ toDecide: 2, open: 2 });

        const replaced = list([run({ status: 'SUPERSEDED', findings: [shown('a', 'READY')] })])[0];
        expect(replaced.counts.toDecide).toBe(0);
        expect(replaced.group).not.toBe('decision');
    });

    it('does not call a fix verified before a re-scan has confirmed it', () => {
        const applied = list([run({ status: 'AWAITING_APPROVAL', findings: [shown('a', 'IMPLEMENTED')] })])[0];
        expect(applied).toMatchObject({ label: 'Fix applied, not yet verified', tone: 'info' });

        const rechecking = list([
            run({ status: 'SUPERSEDED', updatedAt: '2026-10-01T09:00:00Z', findings: [shown('a', 'IMPLEMENTED')] }),
            run({ status: 'QUEUED', updatedAt: '2026-10-01T10:25:00Z' }),
        ])[0];
        expect(rechecking).toMatchObject({ label: 'Re-checking after the fix', group: 'progress' });
        expect(rechecking.counts).toEqual({ found: 1, fixed: 1, toDecide: 0, open: null });
    });

    it('labels failed and running reviews, leaving "still open" unknown', () => {
        expect(list([run({ status: 'FAILED' })])[0]).toMatchObject({ label: 'Did not complete', tone: 'danger', group: 'failed', counts: { open: null } });
        expect(list([run({ status: 'QUEUED', updatedAt: '2026-10-01T10:25:00Z' })])[0]).toMatchObject({ label: 'In progress', group: 'progress', counts: { open: null } });
    });

    it('ignores AI logic suggestions entirely: no count, no status', () => {
        const [item] = list([run({ findings: [logic('l1'), logic('l2'), { source: 'SEMGREP', fingerprint: 'h', occurrence: 1, triageDecision: 'SUPPRESS', fixes: [] }] })]);
        expect(item).toMatchObject({ label: 'No issues', tone: 'success', group: 'clean' });
        expect(item.counts).toEqual({ found: 0, fixed: 0, toDecide: 0, open: 0 });
        expect(JSON.stringify(item)).not.toMatch(/logic/i);
    });

    it('shows one row per pull request: the newest review that was not replaced', () => {
        const items = list([
            run({ id: 'old', status: 'SUPERSEDED', headSha: '1111111aaaa', updatedAt: '2026-10-01T09:00:00Z' }),
            run({ id: 'current', status: 'COMPLETED', headSha: '2222222bbbb', updatedAt: '2026-10-01T10:00:00Z' }),
            // a replaced review can be touched after the current one finished
            run({ id: 'touched', status: 'SUPERSEDED', headSha: '3333333cccc', updatedAt: '2026-10-01T10:20:00Z' }),
        ]);
        expect(items).toHaveLength(1);
        expect(items[0].runId).toBe('current');
        expect(items[0].earlier.map(e => e.runId)).toEqual(['touched', 'old']);
        expect(items[0].earlier[0].label).toBe('No issues');
    });

    it('falls back to the newest review when every review of the pull request was replaced', () => {
        const items = list([
            run({ id: 'a', status: 'SUPERSEDED', updatedAt: '2026-10-01T09:00:00Z' }),
            run({ id: 'b', status: 'SUPERSEDED', updatedAt: '2026-10-01T10:00:00Z' }),
        ]);
        expect(items[0].runId).toBe('b');
        expect(items[0].counts.open).toBeNull();
    });

    it('orders pull requests by their latest activity', () => {
        const items = list([
            run({ id: 'x', pullRequest: { id: 'prA', number: 1, title: 'A', url: 'u' }, updatedAt: '2026-10-01T09:00:00Z' }),
            run({ id: 'y', pullRequest: { id: 'prB', number: 2, title: 'B', url: 'u' }, updatedAt: '2026-10-01T10:00:00Z' }),
        ]);
        expect(items.map(i => i.prNumber)).toEqual([2, 1]);
    });
});

describe('stalled reviews', () => {
    it('shows a review that stopped progressing as not completed, not as in progress forever', () => {
        const stuck = list([run({ status: 'QUEUED', updatedAt: '2026-10-01T07:00:00Z' })])[0];
        expect(stuck).toMatchObject({ label: 'Did not complete', group: 'failed', tone: 'danger' });
    });

    it('keeps a recently updated review in progress', () => {
        const fresh = list([run({ status: 'FIXING', updatedAt: '2026-10-01T10:20:00Z' })])[0];
        expect(fresh).toMatchObject({ label: 'In progress', group: 'progress' });
    });
});
