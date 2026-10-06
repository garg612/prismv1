/**
 * Feedback on a finding feeds the false-alarm rate and the triage model, so it has to resist
 * abuse: one answer per person per finding, owner only, no way to probe other accounts' findings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const FINDING = '11111111-1111-4111-8111-111111111111';
const HIDDEN = '22222222-2222-4222-8222-222222222222';
const LOGIC = '33333333-3333-4333-8333-333333333333';
const MISSING = '99999999-9999-4999-8999-999999999999';

interface FakeFinding { id: string; ownerId: string; source: string; triageDecision: string | null; reviewRunId: string; runStatus: string }
interface FakeFeedback { findingId: string; userId: string; kind: string; createdAt: Date }

const db = vi.hoisted(() => ({
    findings: [] as FakeFinding[],
    feedback: [] as FakeFeedback[],
    classifications: [] as any[],
    runCounters: { surfacedCount: 0, suppressedCount: 0 },
}));

vi.mock('../../src/lib/db', () => {
    const client: any = {
        finding: {
            findFirst: vi.fn(async ({ where }: any) => {
                const f = db.findings.find(x => x.id === where.id && x.ownerId === where.reviewRun.repository.userId);
                return f ? { id: f.id, source: f.source, triageDecision: f.triageDecision, reviewRunId: f.reviewRunId, reviewRun: { status: f.runStatus } } : null;
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                const hit = db.findings.filter(x => x.id === where.id && x.triageDecision === where.triageDecision);
                hit.forEach(x => Object.assign(x, data));
                return { count: hit.length };
            }),
            update: vi.fn(async ({ where, data }: any) => {
                const hit = db.findings.find(x => x.id === where.id);
                if (hit) Object.assign(hit, data);
                return hit;
            }),
        },
        findingClassification: { create: vi.fn(async ({ data }: any) => { db.classifications.push(data); return data; }) },
        findingFeedback: {
            upsert: vi.fn(async ({ where, create, update }: any) => {
                const key = where.findingId_userId_kind;
                const existing = db.feedback.find(x => x.findingId === key.findingId && x.userId === key.userId && x.kind === key.kind);
                if (existing) { Object.assign(existing, update); return existing; }
                const row = { createdAt: new Date(), ...create };
                db.feedback.push(row);
                return row;
            }),
            deleteMany: vi.fn(async ({ where }: any) => {
                const kinds: string[] = where.kind?.in ?? [where.kind];
                const notKind = where.kind?.not;
                const before = db.feedback.length;
                db.feedback = db.feedback.filter(x => {
                    const matchIds = x.findingId === where.findingId && x.userId === where.userId;
                    const matchIn = kinds.includes(x.kind);
                    const matchNot = notKind ? x.kind !== notKind : true;
                    return !(matchIds && matchIn && matchNot);
                });
                return { count: before - db.feedback.length };
            }),
        },
        reviewRun: {
            update: vi.fn(async ({ data }: any) => {
                db.runCounters.surfacedCount += data.surfacedCount.increment;
                db.runCounters.suppressedCount -= data.suppressedCount.decrement;
            }),
        },
    };
    client.$transaction = vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(client) : Promise.all(arg)));
    return { default: client, prisma: client };
});

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string } } }));
vi.mock('../../src/lib/auth', () => ({ auth: { api: { getSession: vi.fn(async () => session.current) } } }));

import { recordFeedback } from '../../src/modules/review/lib/feedback';
import { POST } from '../../src/app/api/findings/[id]/feedback/route';
import { FEEDBACK_LIMIT, rateLimit, resetRateLimits } from '../../src/lib/rate-limit';

const verdictRows = (findingId = FINDING, userId = OWNER) =>
    db.feedback.filter(f => f.findingId === findingId && f.userId === userId && (f.kind === 'TRUE_POSITIVE' || f.kind === 'FALSE_POSITIVE'));

beforeEach(() => {
    db.findings = [
        { id: FINDING, ownerId: OWNER, source: 'SEMGREP', triageDecision: 'SURFACE', reviewRunId: 'run1', runStatus: 'COMPLETED' },
        { id: HIDDEN, ownerId: OWNER, source: 'SEMGREP', triageDecision: 'SUPPRESS', reviewRunId: 'run1', runStatus: 'COMPLETED' },
        { id: LOGIC, ownerId: OWNER, source: 'CUSTOM', triageDecision: null, reviewRunId: 'run1', runStatus: 'COMPLETED' },
    ];
    db.feedback = [];
    db.classifications = [];
    db.runCounters = { surfacedCount: 0, suppressedCount: 1 };
    session.current = { user: { id: OWNER } };
    resetRateLimits();
});

describe('recordFeedback', () => {
    it('stores one answer', async () => {
        expect(await recordFeedback(OWNER, FINDING, 'FALSE_POSITIVE')).toEqual({ ok: true, verdict: 'FALSE_ALARM', unsuppressed: true });
        expect(verdictRows().map(f => f.kind)).toEqual(['FALSE_POSITIVE']);
    });

    it('stores reason for FALSE_POSITIVE', async () => {
        expect(await recordFeedback(OWNER, FINDING, 'FALSE_POSITIVE', 'TEST_CODE' as any)).toEqual({ ok: true, verdict: 'FALSE_ALARM', unsuppressed: true });
        const rows = verdictRows();
        expect(rows.map(f => f.kind)).toEqual(['FALSE_POSITIVE']);
        expect(rows[0]).toMatchObject({ reason: 'TEST_CODE' });
    });

    it('keeps exactly one answer however often it is repeated', async () => {
        for (let i = 0; i < 50; i++) await recordFeedback(OWNER, FINDING, 'FALSE_POSITIVE');
        expect(verdictRows()).toHaveLength(1);
    });

    it('replaces the answer when the user changes their mind', async () => {
        await recordFeedback(OWNER, FINDING, 'FALSE_POSITIVE');
        expect(await recordFeedback(OWNER, FINDING, 'TRUE_POSITIVE')).toMatchObject({ ok: true, verdict: 'REAL' });
        expect(verdictRows().map(f => f.kind)).toEqual(['TRUE_POSITIVE']);
    });

    it('withdraws the answer on CLEAR and leaves other feedback alone', async () => {
        db.feedback.push({ findingId: FINDING, userId: OWNER, kind: 'FIX_ACCEPTED', createdAt: new Date() });
        await recordFeedback(OWNER, FINDING, 'TRUE_POSITIVE');
        expect(await recordFeedback(OWNER, FINDING, 'CLEAR')).toEqual({ ok: true, verdict: null, unsuppressed: false });
        expect(verdictRows()).toHaveLength(0);
        expect(db.feedback.map(f => f.kind)).toEqual(['FIX_ACCEPTED']);
    });

    it('gives the same answer for a finding in someone else\'s repository and one that does not exist', async () => {
        const foreign = await recordFeedback(STRANGER, FINDING, 'FALSE_POSITIVE');
        const missing = await recordFeedback(STRANGER, MISSING, 'FALSE_POSITIVE');
        expect(foreign).toEqual({ ok: false, status: 404, error: 'Finding not found' });
        expect(missing).toEqual(foreign);
        expect(db.feedback).toHaveLength(0);
    });

    it('rejects an id that is not a UUID without querying', async () => {
        const result = await recordFeedback(OWNER, "x' OR 1=1 --", 'FALSE_POSITIVE');
        expect(result).toMatchObject({ ok: false, status: 404 });
    });

    it('collects nothing for AI logic suggestions: they are optional reading, not tracked issues', async () => {
        for (const action of ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'CLEAR', 'UNSUPPRESS'] as const) {
            expect(await recordFeedback(OWNER, LOGIC, action)).toMatchObject({ ok: false, status: 409 });
        }
        expect(db.feedback).toHaveLength(0);
    });

    describe('UNSUPPRESS', () => {
        it('really shows a hidden issue, and records why', async () => {
            expect(await recordFeedback(OWNER, HIDDEN, 'UNSUPPRESS')).toEqual({ ok: true, verdict: null, unsuppressed: true });
            expect(db.findings.find(f => f.id === HIDDEN)!.triageDecision).toBe('SURFACE');
            expect(db.classifications).toHaveLength(1);
            expect(db.classifications[0]).toMatchObject({ decisionSource: 'OVERRIDE', finalDecision: 'SURFACE', isShadow: false });
            expect(db.runCounters).toEqual({ surfacedCount: 1, suppressedCount: 0 });
        });

        it('also brings back an issue triage scored low without a clear noise verdict', async () => {
            const f = db.findings.find(x => x.id === HIDDEN)!;
            f.triageDecision = 'UNCERTAIN';
            db.runCounters = { surfacedCount: 0, suppressedCount: 0 };
            expect(await recordFeedback(OWNER, HIDDEN, 'UNSUPPRESS')).toEqual({ ok: true, verdict: null, unsuppressed: true });
            expect(f.triageDecision).toBe('SURFACE');
            expect(db.classifications[0]).toMatchObject({ decisionSource: 'OVERRIDE', modelDecision: 'UNCERTAIN', finalDecision: 'SURFACE' });
            // it was never counted as suppressed, so that counter must not go below zero
            expect(db.runCounters).toEqual({ surfacedCount: 1, suppressedCount: 0 });
        });

        it('happens once: a second request changes nothing', async () => {
            await recordFeedback(OWNER, HIDDEN, 'UNSUPPRESS');
            expect(await recordFeedback(OWNER, HIDDEN, 'UNSUPPRESS')).toMatchObject({ ok: false, status: 409 });
            expect(db.classifications).toHaveLength(1);
            expect(db.runCounters).toEqual({ surfacedCount: 1, suppressedCount: 0 });
        });

        it('is refused for an issue that is not hidden', async () => {
            expect(await recordFeedback(OWNER, FINDING, 'UNSUPPRESS')).toMatchObject({ ok: false, status: 409 });
            expect(await recordFeedback(OWNER, LOGIC, 'UNSUPPRESS')).toMatchObject({ ok: false, status: 409 });
            expect(db.classifications).toHaveLength(0);
        });

        it('is refused while the review is still running or was replaced', async () => {
            for (const status of ['QUEUED', 'FIXING', 'SUPERSEDED', 'FAILED']) {
                db.findings.find(f => f.id === HIDDEN)!.runStatus = status;
                expect(await recordFeedback(OWNER, HIDDEN, 'UNSUPPRESS')).toMatchObject({ ok: false, status: 409 });
            }
            expect(db.findings.find(f => f.id === HIDDEN)!.triageDecision).toBe('SUPPRESS');
        });

        it('cannot be used on another account\'s finding', async () => {
            expect(await recordFeedback(STRANGER, HIDDEN, 'UNSUPPRESS')).toMatchObject({ ok: false, status: 404 });
            expect(db.findings.find(f => f.id === HIDDEN)!.triageDecision).toBe('SUPPRESS');
        });
    });
});

describe('POST /api/findings/:id/feedback', () => {
    const call = (id: string, body: unknown, headers: Record<string, string> = {}) =>
        POST(
            new NextRequest(`http://localhost:3000/api/findings/${id}/feedback`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', host: 'localhost:3000', ...headers },
                body: typeof body === 'string' ? body : JSON.stringify(body),
            }),
            { params: Promise.resolve({ id }) }
        );

    it('saves an answer and returns only the verdict', async () => {
        const res = await call(FINDING, { action: 'TRUE_POSITIVE' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ verdict: 'REAL', unsuppressed: true });
    });

    it('accepts reason for FALSE_POSITIVE', async () => {
        const res = await call(FINDING, { action: 'FALSE_POSITIVE', reason: 'TEST_CODE' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ verdict: 'FALSE_ALARM', unsuppressed: true });
    });

    it('answers 401 without a session, as JSON and without touching the database', async () => {
        session.current = null;
        const res = await call(FINDING, { action: 'TRUE_POSITIVE' });
        expect(res.status).toBe(401);
        expect(db.feedback).toHaveLength(0);
    });

    it('answers 404 for another account\'s finding', async () => {
        session.current = { user: { id: STRANGER } };
        const res = await call(FINDING, { action: 'FALSE_POSITIVE' });
        expect(res.status).toBe(404);
        expect(db.feedback).toHaveLength(0);
    });

    it('rejects unknown actions, extra fields, bad JSON and oversized bodies', async () => {
        expect((await call(FINDING, { action: 'FIX_ACCEPTED' })).status).toBe(400);
        expect((await call(FINDING, { action: 'TRUE_POSITIVE', userId: STRANGER })).status).toBe(400);
        expect((await call(FINDING, '{not json')).status).toBe(400);
        expect((await call(FINDING, { action: 'TRUE_POSITIVE', pad: 'x'.repeat(5000) })).status).toBe(413);
        expect(db.feedback).toHaveLength(0);
    });

    it('rejects a cross-site request and a non-JSON content type', async () => {
        expect((await call(FINDING, { action: 'FALSE_POSITIVE' }, { origin: 'https://evil.example' })).status).toBe(403);
        expect((await call(FINDING, { action: 'FALSE_POSITIVE' }, { 'content-type': 'text/plain' })).status).toBe(415);
        expect((await call(FINDING, { action: 'FALSE_POSITIVE' }, { origin: 'http://localhost:3000' })).status).toBe(200);
    });

    it('rate-limits one user without affecting another', async () => {
        for (let i = 0; i < FEEDBACK_LIMIT.limit; i++) expect((await call(FINDING, { action: 'TRUE_POSITIVE' })).status).toBe(200);
        const blocked = await call(FINDING, { action: 'TRUE_POSITIVE' });
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

        session.current = { user: { id: STRANGER } };
        expect((await call(FINDING, { action: 'TRUE_POSITIVE' })).status).toBe(404); // not rate limited, just not theirs
    });
});

describe('rateLimit', () => {
    it('allows up to the limit, then blocks until the window moves on', () => {
        const limit = { limit: 3, windowMs: 1000 };
        expect([0, 1, 2].map(t => rateLimit('k', limit, t).allowed)).toEqual([true, true, true]);
        const blocked = rateLimit('k', limit, 500);
        expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 1 });
        expect(rateLimit('k', limit, 1001).allowed).toBe(true);
    });

    it('does not let blocked requests extend the block', () => {
        const limit = { limit: 1, windowMs: 1000 };
        rateLimit('k', limit, 0);
        for (let t = 100; t < 1000; t += 100) expect(rateLimit('k', limit, t).allowed).toBe(false);
        expect(rateLimit('k', limit, 1000).allowed).toBe(true);
    });
});
