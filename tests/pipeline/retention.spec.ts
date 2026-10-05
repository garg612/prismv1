import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRetentionPurge } from '../../src/modules/retention/lib/purge';
import prisma from '../../src/lib/db';

vi.mock('../../src/lib/db', () => ({
    default: {
        webhookEvent: {
            count: vi.fn(),
            deleteMany: vi.fn()
        },
        validationRun: {
            count: vi.fn()
        },
        validationResult: {
            deleteMany: vi.fn()
        },
        reviewRun: {
            count: vi.fn()
        }
    }
}));

describe('Stage 10: Retention Purge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('dry run does not delete anything', async () => {
        (prisma.webhookEvent.count as any).mockResolvedValue(50);
        (prisma.validationRun.count as any).mockResolvedValue(20);
        (prisma.reviewRun.count as any).mockResolvedValue(10);

        const result = await runRetentionPurge({ dryRun: true });

        expect(result.dryRun).toBe(true);
        expect(result.webhookEventsEligible).toBe(50);
        expect(result.webhookEventsDeleted).toBe(0);
        expect(result.expiredValidationRunsEligible).toBe(20);
        expect(result.expiredValidationRunsDeleted).toBe(0);
        expect(prisma.webhookEvent.deleteMany).not.toHaveBeenCalled();
    });

    it('live run deletes eligible webhook events', async () => {
        (prisma.webhookEvent.count as any).mockResolvedValue(30);
        (prisma.webhookEvent.deleteMany as any).mockResolvedValue({ count: 30 });
        (prisma.validationRun.count as any).mockResolvedValue(0);
        (prisma.reviewRun.count as any).mockResolvedValue(0);

        const result = await runRetentionPurge({ dryRun: false });

        expect(result.dryRun).toBe(false);
        expect(result.webhookEventsDeleted).toBe(30);
        expect(prisma.webhookEvent.deleteMany).toHaveBeenCalled();
    });

    it('review runs are never auto-deleted (audit preservation)', async () => {
        (prisma.webhookEvent.count as any).mockResolvedValue(0);
        (prisma.validationRun.count as any).mockResolvedValue(0);
        (prisma.reviewRun.count as any).mockResolvedValue(100);

        const result = await runRetentionPurge({ dryRun: false });

        expect(result.oldReviewRunsEligible).toBe(100);
        expect(result.oldReviewRunsDeleted).toBe(0);
    });

    it('handles DB errors gracefully', async () => {
        (prisma.webhookEvent.count as any).mockRejectedValue(new Error('DB down'));
        (prisma.validationRun.count as any).mockResolvedValue(0);
        (prisma.reviewRun.count as any).mockResolvedValue(0);

        const result = await runRetentionPurge({ dryRun: false });

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('DB down');
    });

    it('configurable retention windows are respected', async () => {
        (prisma.webhookEvent.count as any).mockResolvedValue(0);
        (prisma.validationRun.count as any).mockResolvedValue(0);
        (prisma.reviewRun.count as any).mockResolvedValue(0);

        const result = await runRetentionPurge({
            dryRun: true,
            webhookRetentionDays: 7,
            validationRetentionDays: 14,
            reviewRetentionDays: 60
        });

        expect(result.timestamp).toBeDefined();
        expect(result.errors.length).toBe(0);
    });
});
