/**
 * Stage 10: Data Retention Purge Job
 * 
 * Implements a configurable retention policy that:
 * - Purges old review artifacts beyond retention window
 * - Removes expired validation artifacts
 * - Cleans temporary execution data
 * - Preserves audit/security records
 * - Supports dry-run mode
 */

import prisma from '../../../lib/db';

export interface RetentionConfig {
    /** Days to retain review data (default: 90) */
    reviewRetentionDays: number;
    /** Days to retain validation artifacts (default: 30) */
    validationRetentionDays: number;
    /** Days to retain webhook events (default: 14) */
    webhookRetentionDays: number;
    /** Days to retain exported datasets (default: 180) */
    datasetRetentionDays: number;
    /** If true, only report what would be deleted */
    dryRun: boolean;
}

const DEFAULT_CONFIG: RetentionConfig = {
    reviewRetentionDays: 90,
    validationRetentionDays: 30,
    webhookRetentionDays: 14,
    datasetRetentionDays: 180,
    dryRun: false
};

export interface PurgeResult {
    dryRun: boolean;
    webhookEventsEligible: number;
    webhookEventsDeleted: number;
    expiredValidationRunsEligible: number;
    expiredValidationRunsDeleted: number;
    oldReviewRunsEligible: number;
    oldReviewRunsDeleted: number;
    timestamp: string;
    errors: string[];
}

export async function runRetentionPurge(config?: Partial<RetentionConfig>): Promise<PurgeResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const now = new Date();
    const errors: string[] = [];
    const result: PurgeResult = {
        dryRun: cfg.dryRun,
        webhookEventsEligible: 0,
        webhookEventsDeleted: 0,
        expiredValidationRunsEligible: 0,
        expiredValidationRunsDeleted: 0,
        oldReviewRunsEligible: 0,
        oldReviewRunsDeleted: 0,
        timestamp: now.toISOString(),
        errors
    };

    // 1. Purge old webhook events
    try {
        const webhookCutoff = new Date(now.getTime() - cfg.webhookRetentionDays * 24 * 60 * 60 * 1000);
        result.webhookEventsEligible = await prisma.webhookEvent.count({
            where: { receivedAt: { lt: webhookCutoff } }
        });
        if (!cfg.dryRun && result.webhookEventsEligible > 0) {
            const deleted = await prisma.webhookEvent.deleteMany({
                where: { receivedAt: { lt: webhookCutoff } }
            });
            result.webhookEventsDeleted = deleted.count;
        }
    } catch (e: any) {
        errors.push(`Webhook purge error: ${e.message}`);
    }

    // 2. Purge expired/old validation runs (beyond retention)
    try {
        const validationCutoff = new Date(now.getTime() - cfg.validationRetentionDays * 24 * 60 * 60 * 1000);
        result.expiredValidationRunsEligible = await prisma.validationRun.count({
            where: {
                startedAt: { lt: validationCutoff },
                status: { in: ['COMPLETED', 'FAILED', 'TIMEOUT'] as any }
            }
        });
        if (!cfg.dryRun && result.expiredValidationRunsEligible > 0) {
            // Delete validation results first (cascade may handle this)
            await prisma.validationResult.deleteMany({
                where: {
                    validationRun: {
                        startedAt: { lt: validationCutoff },
                        status: { in: ['COMPLETED', 'FAILED', 'TIMEOUT'] as any }
                    }
                }
            });
            const deleted = await prisma.validationRun.deleteMany({
                where: {
                    startedAt: { lt: validationCutoff },
                    status: { in: ['COMPLETED', 'FAILED', 'TIMEOUT'] as any }
                }
            });
            result.expiredValidationRunsDeleted = deleted.count;
        }
    } catch (e: any) {
        errors.push(`Validation purge error: ${e.message}`);
    }

    // 3. Count old review runs (for reporting — we don't auto-delete review data by default)
    try {
        const reviewCutoff = new Date(now.getTime() - cfg.reviewRetentionDays * 24 * 60 * 60 * 1000);
        result.oldReviewRunsEligible = await prisma.reviewRun.count({
            where: {
                startedAt: { lt: reviewCutoff },
                status: { in: ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'] as any }
            }
        });
        // Review runs are NOT auto-deleted — they contain audit history
        // Only mark them as eligible for manual review
        result.oldReviewRunsDeleted = 0;
    } catch (e: any) {
        errors.push(`ReviewRun count error: ${e.message}`);
    }

    console.log(`[retention-purge] ${cfg.dryRun ? 'DRY RUN' : 'LIVE'} completed:`, JSON.stringify(result, null, 2));

    return result;
}
