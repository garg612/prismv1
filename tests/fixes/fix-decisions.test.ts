/**
 * Accepting and rejecting a fix feed the fix-acceptance rate. A decision must be made once,
 * by the owner, and a rejection must not overwrite a fix that is being applied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    fix: null as any,
    session: null as any,
    feedbackUpserts: [] as any[],
    findingUpdates: [] as any[],
    /** Simulates another request changing the fix between this request's read and its write */
    raceTo: null as string | null,
    claimCount: null as number | null,
    released: 0,
}));

vi.mock('../../src/lib/db', () => {
    const client = {
        suggestedFix: {
            findUnique: vi.fn(async () => state.fix),
            findMany: vi.fn(async () => (state.fix ? [state.fix] : [])),
            update: vi.fn(async ({ data }: any) => { Object.assign(state.fix, data); return state.fix; }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                if (where.id?.in) {
                    if (data.status === 'READY') { state.released++; return { count: 0 }; }
                    return { count: state.claimCount ?? where.id.in.length };
                }
                if (state.raceTo) state.fix.status = state.raceTo;
                if (state.fix.status !== where.status) return { count: 0 };
                state.fix.status = data.status;
                return { count: 1 };
            }),
        },
        finding: { update: vi.fn(async (args: any) => { state.findingUpdates.push(args); }) },
        findingFeedback: { upsert: vi.fn(async (args: any) => { state.feedbackUpserts.push(args); }), create: vi.fn() },
        reviewRun: { findUnique: vi.fn(async () => state.fix?.finding.reviewRun) },
        validationRun: { findFirst: vi.fn(async () => ({ id: 'vr', status: 'COMPLETED', headSha: 'head', includedFixIds: ['fix-1'] })) },
        validationResult: { findFirst: vi.fn(async () => null) },
        account: { findFirst: vi.fn(async () => ({ accessToken: 'token' })) },
        review: { findUnique: vi.fn() },
        applyAttempt: { create: vi.fn(), update: vi.fn() },
    };
    return { default: client, prisma: client };
});
vi.mock('../../src/lib/auth', () => ({ auth: { api: { getSession: vi.fn(async () => state.session) } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock('../../src/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('../../src/modules/github/lib/github', () => ({ getGithubToken: vi.fn(async () => 'token') }));
const apply = vi.hoisted(() => ({ fn: null as any }));
vi.mock('../../src/modules/github/lib/apply-fix', () => {
    apply.fn = vi.fn(async () => ({ success: true }));
    return { applyFixToGithub: apply.fn };
});
vi.mock('octokit', () => ({ Octokit: class {} }));

import { acceptReadyFixes, rejectFix } from '../../src/modules/review/actions/fixes';
import { FIX_DECISION_LIMIT, resetRateLimits } from '../../src/lib/rate-limit';

beforeEach(() => {
    state.fix = {
        id: 'fix-1', findingId: 'finding-1', status: 'READY', edits: [], expiresAt: null,
        finding: { id: 'finding-1', reviewRun: { id: 'run-1', status: 'AWAITING_APPROVAL', repository: { userId: 'owner', fixDeliveryMode: 'FIX_BRANCH_PR' }, pullRequest: { latestHeadSha: 'head' } } },
    };
    state.session = { user: { id: 'owner' } };
    state.feedbackUpserts = [];
    state.findingUpdates = [];
    state.raceTo = null;
    state.claimCount = null;
    state.released = 0;
    apply.fn.mockClear();
    resetRateLimits();
});

describe('rejectFix', () => {
    it('rejects a ready fix and records one decision', async () => {
        expect(await rejectFix('fix-1')).toEqual({ success: true });
        expect(state.fix.status).toBe('REJECTED');
        expect(state.feedbackUpserts).toHaveLength(1);
        expect(state.feedbackUpserts[0].where.findingId_userId_kind).toEqual({ findingId: 'finding-1', userId: 'owner', kind: 'FIX_REJECTED' });
    });

    it('does not overwrite a fix that started applying in the meantime', async () => {
        state.raceTo = 'IMPLEMENTING';
        expect(await rejectFix('fix-1')).toEqual({ success: false, error: 'FIX_ALREADY_PROCESSING' });
        expect(state.fix.status).toBe('IMPLEMENTING');
        expect(state.feedbackUpserts).toHaveLength(0);
        expect(state.findingUpdates).toHaveLength(0);
    });

    it('cannot be repeated: the second rejection is refused', async () => {
        await rejectFix('fix-1');
        expect(await rejectFix('fix-1')).toEqual({ success: false, error: 'FIX_NOT_READY' });
        expect(state.feedbackUpserts).toHaveLength(1);
    });

    it('is refused for someone who does not own the repository, and without a session', async () => {
        state.session = { user: { id: 'stranger' } };
        expect(await rejectFix('fix-1')).toEqual({ success: false, error: 'FORBIDDEN' });
        state.session = null;
        expect(await rejectFix('fix-1')).toEqual({ success: false, error: 'UNAUTHORIZED' });
        expect(state.fix.status).toBe('READY');
        expect(state.feedbackUpserts).toHaveLength(0);
    });

    it('is rate-limited per user', async () => {
        state.fix.status = 'IMPLEMENTED'; // every call is refused, but still counts towards the limit
        for (let i = 0; i < FIX_DECISION_LIMIT.limit; i++) expect((await rejectFix('fix-1')).error).toBe('FIX_NOT_READY');
        expect((await rejectFix('fix-1')).error).toMatch(/Too many requests/);
    });
});

describe('acceptReadyFixes', () => {
    it('applies nothing when another request already claimed one of the fixes', async () => {
        state.claimCount = 0;
        expect(await acceptReadyFixes('run-1')).toEqual({ success: false, error: 'FIX_ALREADY_PROCESSING' });
        expect(apply.fn).not.toHaveBeenCalled();
        expect(state.released).toBe(1);
        expect(state.feedbackUpserts).toHaveLength(0);
    });

    it('releases its claim when applying fails, so the fixes can be decided again', async () => {
        apply.fn.mockResolvedValueOnce({ success: false, error: 'FIX_CONFLICT' });
        expect(await acceptReadyFixes('run-1')).toEqual({ success: false, error: 'FIX_CONFLICT' });
        expect(state.released).toBe(1);
        expect(state.feedbackUpserts).toHaveLength(0);
    });
});
