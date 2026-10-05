/**
 * The quality numbers (false-alarm rate, fix acceptance rate) must be counts of real decisions,
 * must not be inflatable, and must not turn a handful of answers into a percentage.
 */
import { describe, it, expect } from 'vitest';
import { buildMetrics, distinctIssues, explicitVerdictOf, MetricFinding, MIN_SAMPLE, ruleFalseAlarmRates, verdictOf, weekStart } from '../../src/modules/metrics/lib/metrics';

let seq = 0;
const finding = (over: Partial<MetricFinding> = {}): MetricFinding => {
    seq++;
    return {
        id: `f${seq}`, pullRequestId: 'pr1', source: 'SEMGREP', ruleId: 'rule-a', fingerprint: `fp${seq}`, occurrence: 1,
        triageDecision: 'SURFACE', createdAt: '2026-09-15T10:00:00Z', feedback: [], fixes: [], ...over,
    };
};
const fb = (kind: string, createdAt = '2026-09-15T11:00:00Z') => ({ kind, createdAt });
const fix = (status: string, id = `x${++seq}`, updatedAt = '2026-09-16T10:00:00Z') => ({ id, status, updatedAt });
const range = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z') };

describe('verdictOf', () => {
    it('has no verdict without any decision', () => {
        expect(verdictOf([], [])).toBeNull();
    });

    it('uses the latest explicit answer', () => {
        expect(verdictOf([fb('TRUE_POSITIVE', '2026-09-15T11:00:00Z'), fb('FALSE_POSITIVE', '2026-09-15T12:00:00Z')], [])).toBe('FALSE_ALARM');
        expect(verdictOf([fb('FALSE_POSITIVE', '2026-09-15T11:00:00Z'), fb('TRUE_POSITIVE', '2026-09-15T12:00:00Z')], [])).toBe('REAL');
    });

    it('treats an applied fix as real when there is no explicit answer', () => {
        expect(verdictOf([], [{ status: 'IMPLEMENTED' }])).toBe('REAL');
        expect(verdictOf([fb('FIX_ACCEPTED')], [])).toBe('REAL');
    });

    it('lets an explicit "false alarm" win over an applied fix', () => {
        expect(verdictOf([fb('FALSE_POSITIVE')], [{ status: 'IMPLEMENTED' }])).toBe('FALSE_ALARM');
    });

    it('does not read a rejected fix as a false alarm', () => {
        expect(verdictOf([fb('FIX_REJECTED')], [{ status: 'REJECTED' }])).toBeNull();
    });

    it('ignores unrelated feedback kinds', () => {
        expect(verdictOf([fb('UNSUPPRESS_REQUEST'), fb('DISMISSED')], [])).toBeNull();
    });

    it('explicitVerdictOf never infers from fixes', () => {
        expect(explicitVerdictOf([fb('FIX_ACCEPTED')])).toBeNull();
        expect(explicitVerdictOf([fb('TRUE_POSITIVE')])).toBe('REAL');
    });
});

describe('distinctIssues', () => {
    it('counts an issue re-detected on later commits of the same pull request once', () => {
        const rows = [
            finding({ fingerprint: 'same', createdAt: '2026-09-10T10:00:00Z' }),
            finding({ fingerprint: 'same', createdAt: '2026-09-11T10:00:00Z' }),
            finding({ fingerprint: 'same', createdAt: '2026-09-12T10:00:00Z' }),
        ];
        expect(distinctIssues(rows)).toHaveLength(1);
    });

    it('keeps the same fingerprint in different pull requests, sources or occurrences apart', () => {
        const rows = [
            finding({ fingerprint: 'same' }),
            finding({ fingerprint: 'same', pullRequestId: 'pr2' }),
            finding({ fingerprint: 'same', source: 'ESLINT' }),
            finding({ fingerprint: 'same', occurrence: 2 }),
        ];
        expect(distinctIssues(rows)).toHaveLength(4);
    });

    it('takes the triage decision of the newest review, whatever order rows arrive in', () => {
        const older = finding({ fingerprint: 'same', createdAt: '2026-09-10T10:00:00Z', triageDecision: 'SUPPRESS' });
        const newer = finding({ fingerprint: 'same', createdAt: '2026-09-12T10:00:00Z', triageDecision: 'SURFACE' });
        expect(distinctIssues([older, newer])[0].triageDecision).toBe('SURFACE');
        expect(distinctIssues([newer, older])[0].triageDecision).toBe('SURFACE');
    });

    it('merges decisions made on any of the reviews', () => {
        const rows = [
            finding({ fingerprint: 'same', createdAt: '2026-09-10T10:00:00Z', feedback: [fb('FALSE_POSITIVE')] }),
            finding({ fingerprint: 'same', createdAt: '2026-09-12T10:00:00Z' }),
        ];
        const m = buildMetrics(rows, range);
        expect(m.falseAlarms.count).toBe(1);
        expect(m.falseAlarms.of).toBe(1);
    });
});

describe('buildMetrics', () => {
    it('gives no percentage below the minimum sample, but still gives the counts', () => {
        const rows = Array.from({ length: MIN_SAMPLE - 1 }, () => finding({ feedback: [fb('FALSE_POSITIVE')] }));
        const m = buildMetrics(rows, range);
        expect(m.falseAlarms.value).toBeNull();
        expect(m.falseAlarms.count).toBe(MIN_SAMPLE - 1);
        expect(m.falseAlarms.of).toBe(MIN_SAMPLE - 1);
    });

    it('computes the false-alarm rate over judged shown issues only', () => {
        const rows = [
            ...Array.from({ length: 2 }, () => finding({ feedback: [fb('FALSE_POSITIVE')] })),
            ...Array.from({ length: 6 }, () => finding({ feedback: [fb('TRUE_POSITIVE')] })),
            ...Array.from({ length: 4 }, () => finding()),                                   // shown, no answer
            finding({ triageDecision: 'SUPPRESS', feedback: [fb('FALSE_POSITIVE')] }),      // hidden: not part of the rate
        ];
        const m = buildMetrics(rows, range);
        expect(m.falseAlarms).toMatchObject({ count: 2, of: 8, real: 6, unjudged: 4 });
        expect(m.falseAlarms.value).toBeCloseTo(0.25);
        expect(m.issues).toEqual({ total: 13, shown: 12, filtered: 1, untriaged: 0 });
    });

    it('cannot be inflated by repeating the same answer', () => {
        const spam = Array.from({ length: 500 }, (_, i) => fb('FALSE_POSITIVE', new Date(Date.UTC(2026, 8, 15, 0, 0, i)).toISOString()));
        const rows = [finding({ feedback: spam }), ...Array.from({ length: 9 }, () => finding({ feedback: [fb('TRUE_POSITIVE')] }))];
        const m = buildMetrics(rows, range);
        expect(m.falseAlarms).toMatchObject({ count: 1, of: 10 });
        expect(m.falseAlarms.value).toBeCloseTo(0.1);
    });

    it('computes fix acceptance from fix states, counting each fix once', () => {
        const shared = fix('IMPLEMENTED', 'shared-fix');
        const rows = [
            // the same fix seen through two reviews of the same issue
            finding({ fingerprint: 'dup', fixes: [shared], createdAt: '2026-09-10T10:00:00Z' }),
            finding({ fingerprint: 'dup', fixes: [shared], createdAt: '2026-09-11T10:00:00Z' }),
            ...Array.from({ length: 3 }, () => finding({ fixes: [fix('IMPLEMENTED')] })),
            finding({ fixes: [fix('REJECTED')] }),
            finding({ fixes: [fix('READY')] }),
            finding({ fixes: [fix('NOT_READY')] }),
        ];
        const m = buildMetrics(rows, range);
        expect(m.fixes).toMatchObject({ count: 4, of: 5, rejected: 1, waiting: 1 });
        expect(m.fixes.value).toBeCloseTo(0.8);
    });

    it('counts nothing about AI logic suggestions, even ones that were answered in the past', () => {
        const rows = [
            finding({ source: 'CUSTOM', triageDecision: null, ruleId: 'logic/off-by-one', feedback: [fb('FALSE_POSITIVE')] }),
            finding({ source: 'CUSTOM', triageDecision: 'SURFACE', ruleId: 'logic/wrong-condition', feedback: [fb('TRUE_POSITIVE')], fixes: [fix('IMPLEMENTED')] }),
            finding(),
        ];
        const m = buildMetrics(rows, range);
        expect(m.issues).toEqual({ total: 1, shown: 1, filtered: 0, untriaged: 0 });
        expect(m.falseAlarms.of).toBe(0);
        expect(m.fixes.of).toBe(0);
        expect(JSON.stringify(m)).not.toMatch(/logic/i);
        expect(ruleFalseAlarmRates(rows, ['logic/off-by-one']).get('logic/off-by-one')).toBeNull();
    });

    it('treats both "not shown" outcomes of triage as filtered out as noise', () => {
        const rows = [
            finding({ triageDecision: 'SUPPRESS' }),
            finding({ triageDecision: 'UNCERTAIN' }),
            finding({ triageDecision: null }),
            finding(),
        ];
        const m = buildMetrics(rows, range);
        expect(m.issues).toEqual({ total: 4, shown: 1, filtered: 2, untriaged: 1 });
        expect(JSON.stringify(m)).not.toMatch(/uncertain/i);
    });

    it('explains every drop in the funnel from the same rows it counts', () => {
        const rows = [
            finding({ fixes: [fix('IMPLEMENTED')] }),                 // applied
            finding({ fixes: [fix('READY')] }),                       // validated, waiting
            finding({ fixes: [fix('REJECTED')] }),                    // validated, rejected
            finding({ fixes: [fix('STALE')] }),                       // validated, out of date
            finding({ fixes: [fix('NOT_READY'), fix('GUARD_REJECTED')] }), // fix failed validation
            finding(),                                                // no fix generated
            finding({ triageDecision: 'SUPPRESS' }),
            finding({ triageDecision: 'UNCERTAIN' }),
            finding({ triageDecision: null }),
        ];
        const f = Object.fromEntries(buildMetrics(rows, range).funnel.map(s => [s.key, s]));
        expect([f.found.count, f.shown.count, f.validated.count, f.applied.count]).toEqual([9, 6, 4, 1]);
        expect(f.found.note).toBe('');
        expect(f.shown.note).toBe('2 filtered out as noise by triage, so you were not asked to look at them, 1 found by a review that stopped before triage.');
        expect(f.validated.note).toBe('1 had a fix generated that did not pass validation, so it was never offered, 1 had no fix generated (fixes are generated for a limited number of issues per review).');
        expect(f.applied.note).toBe('1 is waiting for your decision, 1 was rejected by you, 1 went out of date before a decision.');
        // The numbers in each note add up to the drop they explain.
        for (const [key, above] of [['shown', 'found'], ['validated', 'shown'], ['applied', 'validated']] as const) {
            const explained = (f[key].note.match(/(?:^|, )(\d+) /g) || []).reduce((n: number, m: string) => n + parseInt(m.replace(', ', ''), 10), 0);
            expect(explained).toBe(f[above].count - f[key].count);
        }
    });

    it('says so when a stage loses nothing', () => {
        const f = buildMetrics([finding({ fixes: [fix('IMPLEMENTED')] })], range).funnel;
        expect(f.map(s => s.note)).toEqual(['', 'Every issue found was shown.', 'Every shown issue got a fix that passed validation.', 'Every validated fix was applied.']);
    });

    it('builds a funnel in which no stage is larger than the one before', () => {
        const rows = [
            finding({ fixes: [fix('IMPLEMENTED')] }),
            finding({ fixes: [fix('READY')] }),
            finding({ fixes: [fix('NOT_READY')] }),
            finding({ triageDecision: 'SUPPRESS' }),
        ];
        const counts = buildMetrics(rows, range).funnel.map(f => f.count);
        expect(counts).toEqual([4, 3, 2, 1]);
        for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    });

    it('puts every week of the range on the axis, including empty ones, and totals match', () => {
        const rows = [
            finding({ createdAt: '2026-09-02T10:00:00Z' }),
            finding({ createdAt: '2026-09-02T12:00:00Z', triageDecision: 'SUPPRESS' }),
            finding({ createdAt: '2026-09-23T10:00:00Z', triageDecision: 'UNCERTAIN', fixes: [] }),
            finding({ createdAt: '2026-09-23T10:00:00Z', fixes: [fix('IMPLEMENTED', 'w1', '2026-09-24T10:00:00Z'), fix('REJECTED', 'w2', '2026-09-09T10:00:00Z')] }),
        ];
        const m = buildMetrics(rows, range);
        expect(m.weeks.map(w => w.weekStart)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
        expect(m.weeks.reduce((n, w) => n + w.shown + w.filtered, 0)).toBe(m.issues.total);
        expect(m.weeks.find(w => w.weekStart === '2026-08-31')).toMatchObject({ shown: 1, filtered: 1 });
        expect(m.weeks.find(w => w.weekStart === '2026-09-07')).toMatchObject({ rejected: 1 });
        expect(m.weeks.find(w => w.weekStart === '2026-09-21')).toMatchObject({ shown: 1, filtered: 1, accepted: 1 });
        expect(m.weeks.find(w => w.weekStart === '2026-09-14')).toMatchObject({ shown: 0, filtered: 0, accepted: 0, rejected: 0 });
    });

    it('returns zeros, not NaN, for an account with no data', () => {
        const m = buildMetrics([], range);
        expect(m.issues.total).toBe(0);
        expect(m.falseAlarms).toMatchObject({ count: 0, of: 0, value: null });
        expect(m.fixes.value).toBeNull();
        expect(JSON.stringify(m)).not.toContain('NaN');
    });

});

describe('ruleFalseAlarmRates (triage model input)', () => {
    it('is null for a rule with too few judged issues', () => {
        const rows = Array.from({ length: MIN_SAMPLE - 1 }, () => finding({ ruleId: 'r', feedback: [fb('FALSE_POSITIVE')] }));
        expect(ruleFalseAlarmRates(rows, ['r', 'never-seen'])).toEqual(new Map([['r', null], ['never-seen', null]]));
    });

    it('counts distinct issues, so one issue answered on many commits is one data point', () => {
        const rows = Array.from({ length: 20 }, (_, i) => finding({ ruleId: 'r', fingerprint: 'one', createdAt: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(), feedback: [fb('FALSE_POSITIVE')] }));
        expect(ruleFalseAlarmRates(rows, ['r']).get('r')).toBeNull();
    });

    it('gives the rate once enough distinct issues are judged', () => {
        const rows = [
            ...Array.from({ length: 3 }, () => finding({ ruleId: 'r', feedback: [fb('FALSE_POSITIVE')] })),
            ...Array.from({ length: 3 }, () => finding({ ruleId: 'r', fixes: [fix('IMPLEMENTED')] })),
            finding({ ruleId: 'other', feedback: [fb('FALSE_POSITIVE')] }),
        ];
        expect(ruleFalseAlarmRates(rows, ['r']).get('r')).toBeCloseTo(0.5);
    });
});

describe('weekStart', () => {
    it('is the Monday of the week, in UTC', () => {
        expect(new Date(weekStart(Date.parse('2026-09-16T23:59:59Z'))).toISOString()).toBe('2026-09-14T00:00:00.000Z'); // Wednesday
        expect(new Date(weekStart(Date.parse('2026-09-14T00:00:00Z'))).toISOString()).toBe('2026-09-14T00:00:00.000Z'); // Monday
        expect(new Date(weekStart(Date.parse('2026-09-20T12:00:00Z'))).toISOString()).toBe('2026-09-14T00:00:00.000Z'); // Sunday
    });
});

describe('distinctIssues: reviews that stopped before triage', () => {
    it('keeps the decision of the last review that reached triage', () => {
        const triaged = finding({ fingerprint: 'same', createdAt: '2026-09-10T10:00:00Z', triageDecision: 'SURFACE' });
        const stoppedEarly = finding({ fingerprint: 'same', createdAt: '2026-09-12T10:00:00Z', triageDecision: null });
        expect(distinctIssues([triaged, stoppedEarly])[0].triageDecision).toBe('SURFACE');
        expect(distinctIssues([stoppedEarly, triaged])[0].triageDecision).toBe('SURFACE');
        expect(buildMetrics([triaged, stoppedEarly], range).issues).toEqual({ total: 1, shown: 1, filtered: 0, untriaged: 0 });
    });

    it('is untriaged only when no review of the pull request ever triaged it', () => {
        expect(buildMetrics([finding({ triageDecision: null })], range).issues).toEqual({ total: 1, shown: 0, filtered: 0, untriaged: 1 });
    });
});
