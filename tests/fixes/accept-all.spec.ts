import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acceptReadyFixes } from '../../src/modules/review/actions/fixes';
import prisma from '../../src/lib/db';
import { inngest } from '../../src/inngest/client';

// Mock dependencies
vi.mock('../../src/lib/db', () => ({
    default: {
        reviewRun: { findUnique: vi.fn() },
        // updateMany claims the fixes (READY -> IMPLEMENTING) before anything is applied
        suggestedFix: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(async ({ where }: any) => ({ count: where.id.in.length })) },
        validationRun: { findFirst: vi.fn() },
        validationResult: { findFirst: vi.fn() },
        finding: { update: vi.fn() },
        findingFeedback: { create: vi.fn(), upsert: vi.fn() },
        account: { findFirst: vi.fn() }
    }
}));

vi.mock('../../src/modules/github/lib/apply-fix', () => ({
    applyFixToGithub: vi.fn().mockResolvedValue({ success: true, resultCommitSha: 'mock-sha' })
}));

vi.mock('../../src/lib/auth', () => ({
    auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: 'user1' } }) } }
}));
vi.mock('next/headers', () => ({
    headers: vi.fn()
}));
vi.mock('../../src/inngest/client', () => ({
    inngest: { send: vi.fn() }
}));

describe('Stage 9: Accept All Ready (acceptReadyFixes)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('Case A: Successful exact combined validation allows accept all', async () => {
        (prisma.reviewRun.findUnique as any).mockResolvedValue({
            id: 'run1',
            status: 'AWAITING_APPROVAL',
            repository: { userId: 'user1' },
            pullRequest: { latestHeadSha: 'sha1' }
        });
        (prisma.suggestedFix.findMany as any).mockResolvedValue([
            { id: 'fixA', status: 'READY', findingId: 'findingA', edits: [{ path: 'foo.ts', find: 'A', replace: 'B' }] },
            { id: 'fixB', status: 'READY', findingId: 'findingB', edits: [{ path: 'bar.ts', find: 'C', replace: 'D' }] }
        ]);
        (prisma.account.findFirst as any).mockResolvedValue({ access_token: 'fake-token' });
        (prisma.validationRun.findFirst as any).mockResolvedValue({
            id: 'valRun1',
            kind: 'COMBINED',
            status: 'COMPLETED',
            headSha: 'sha1',
            includedFixIds: ['fixA', 'fixB'].sort() // Note: sorted
        });
        (prisma.validationResult.findFirst as any).mockResolvedValue(null); // No failures
        (prisma.account.findFirst as any).mockResolvedValue({ accessToken: 'ghp_fake' });

        const result = await acceptReadyFixes('run1');
        console.log("ACCEPT ALL RESULT", result);
        
        expect(result.success).toBe(true);
        expect(prisma.suggestedFix.update).toHaveBeenCalledTimes(2);
        expect(prisma.finding.update).toHaveBeenCalledTimes(2);
    });

    it('Case B: No combined validation triggers fast revalidation and blocks', async () => {
        (prisma.reviewRun.findUnique as any).mockResolvedValue({
            id: 'run1',
            status: 'AWAITING_APPROVAL',
            repository: { userId: 'user1' },
            pullRequest: { latestHeadSha: 'sha1' }
        });
        (prisma.suggestedFix.findMany as any).mockResolvedValue([
            { id: 'fixA', status: 'READY' }
        ]);
        (prisma.validationRun.findFirst as any).mockResolvedValue(null); 

        const result = await acceptReadyFixes('run1');
        
        expect(result.success).toBe(false);
        expect(result.error).toContain('Combined validation triggered');
        expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
            name: 'review.combined_validation.requested'
        }));
    });

    it('Case C: User requests subset -> old validation not reused, triggers revalidation', async () => {
        (prisma.reviewRun.findUnique as any).mockResolvedValue({
            id: 'run1',
            status: 'AWAITING_APPROVAL',
            repository: { userId: 'user1' },
            pullRequest: { latestHeadSha: 'sha1' }
        });
        (prisma.suggestedFix.findMany as any).mockResolvedValue([
            { id: 'fixA', status: 'READY' },
            { id: 'fixB', status: 'READY' }
        ]);
        // Old validation had [A, B]
        (prisma.validationRun.findFirst as any).mockResolvedValue({
            id: 'valRun1',
            kind: 'COMBINED',
            status: 'COMPLETED',
            headSha: 'sha1',
            includedFixIds: ['fixA', 'fixB'].sort()
        });

        // User only asks for [fixA]
        const result = await acceptReadyFixes('run1', ['fixA']);
        
        expect(result.success).toBe(false);
        expect(result.error).toContain('Combined validation triggered');
        expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
            data: { reviewRunId: 'run1', fixIds: ['fixA'] }
        }));
    });

    it('Case D: Head SHA changed -> combined validation stale -> blocked', async () => {
        (prisma.reviewRun.findUnique as any).mockResolvedValue({
            id: 'run1',
            status: 'AWAITING_APPROVAL',
            repository: { userId: 'user1' },
            pullRequest: { latestHeadSha: 'sha2' } // New head
        });
        (prisma.suggestedFix.findMany as any).mockResolvedValue([
            { id: 'fixA', status: 'READY' }
        ]);
        // Old validation had sha1
        (prisma.validationRun.findFirst as any).mockResolvedValue({
            id: 'valRun1',
            kind: 'COMBINED',
            status: 'COMPLETED',
            headSha: 'sha1',
            includedFixIds: ['fixA']
        });

        const result = await acceptReadyFixes('run1');
        
        expect(result.success).toBe(false);
        expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
            data: { reviewRunId: 'run1', fixIds: ['fixA'] }
        }));
    });
});
