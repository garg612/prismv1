import { inngest } from "../client";
import prisma from "@/lib/db";

export const aggregateMetrics = inngest.createFunction(
    { id: "aggregate-metrics", triggers: [{ event: "metrics.aggregate" }, { cron: "0 * * * *" }] },
    async ({ step }) => {
        await step.run("calculate-and-store-metrics", async () => {
            await prisma.$transaction(async (tx) => {
                // Determine demo users to exclude
                const demoUsers = await tx.user.findMany({
                    where: { email: { contains: "demo", mode: "insensitive" } },
                    select: { id: true }
                });
                const demoUserIds = demoUsers.map(u => u.id);

                const now = new Date();
                const periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // last 24h as a rough period, though we aggregate all time here for simplicity.
                // Or rather, we can just aggregate all-time for the snapshot, as the report implies snapshotting current state.
                const allTimeStart = new Date(0);

                // 1. Fix Decision Acceptance Rate
                const fixFeedback = await tx.findingFeedback.groupBy({
                    by: ['kind'],
                    where: {
                        userId: { notIn: demoUserIds },
                        kind: { in: ['FIX_ACCEPTED', 'FIX_REJECTED'] }
                    },
                    _count: { id: true }
                });

                let accepted = 0;
                let rejected = 0;
                for (const f of fixFeedback) {
                    if (f.kind === 'FIX_ACCEPTED') accepted += f._count.id;
                    if (f.kind === 'FIX_REJECTED') rejected += f._count.id;
                }

                const fixDenominator = accepted + rejected;
                const fixValue = fixDenominator > 0 ? (accepted / fixDenominator) * 100 : 0;

                const fixUsers = await tx.findingFeedback.groupBy({
                    by: ['userId'],
                    where: {
                        userId: { notIn: demoUserIds },
                        kind: { in: ['FIX_ACCEPTED', 'FIX_REJECTED'] }
                    }
                });

                await tx.globalMetricSnapshot.create({
                    data: {
                        metric: 'FIX_ACCEPTANCE_RATE',
                        value: fixValue,
                        numerator: accepted,
                        denominator: fixDenominator,
                        accountCount: fixUsers.length,
                        periodStart: allTimeStart,
                        periodEnd: now,
                    }
                });

                // 2. False Alarm Rate (Attributable to PRism/Tooling)
                const fpFeedback = await tx.findingFeedback.groupBy({
                    by: ['kind'],
                    where: {
                        userId: { notIn: demoUserIds },
                        kind: { in: ['FALSE_POSITIVE', 'TRUE_POSITIVE', 'MARK_AS_NOISE'] }
                    },
                    _count: { id: true }
                });

                let genuineFalsePositives = 0;
                let userPreferenceFalsePositives = 0;
                let truePositives = 0;

                for (const f of fpFeedback) {
                    if (f.kind === 'TRUE_POSITIVE') {
                        truePositives += f._count.id;
                    } else if (f.kind === 'FALSE_POSITIVE') {
                        genuineFalsePositives += f._count.id;
                    } else if (f.kind === 'MARK_AS_NOISE') {
                        userPreferenceFalsePositives += f._count.id;
                    }
                }

                // We exclude "Not Our Fault" from the denominator entirely so it doesn't skew our accuracy.
                const fpDenominator = genuineFalsePositives + truePositives;
                const fpValue = fpDenominator > 0 ? (genuineFalsePositives / fpDenominator) * 100 : 0;

                const fpUsers = await tx.findingFeedback.groupBy({
                    by: ['userId'],
                    where: {
                        userId: { notIn: demoUserIds },
                        kind: { in: ['FALSE_POSITIVE', 'TRUE_POSITIVE', 'MARK_AS_NOISE'] }
                    }
                });

                await tx.globalMetricSnapshot.create({
                    data: {
                        metric: 'FALSE_ALARM_RATE',
                        value: fpValue,
                        numerator: genuineFalsePositives,
                        denominator: fpDenominator,
                        accountCount: fpUsers.length,
                        periodStart: allTimeStart,
                        periodEnd: now,
                    }
                });

                // 3. User Preference Dismissals (Test Code, Intentional, etc.)
                // Tracking how often users suppress valid findings for personal/repo reasons
                const totalDismissals = genuineFalsePositives + userPreferenceFalsePositives;
                const userPrefValue = totalDismissals > 0 ? (userPreferenceFalsePositives / totalDismissals) * 100 : 0;
                
                await tx.globalMetricSnapshot.create({
                    data: {
                        metric: 'USER_PREF_DISMISSAL_RATE',
                        value: userPrefValue,
                        numerator: userPreferenceFalsePositives,
                        denominator: totalDismissals,
                        accountCount: fpUsers.length,
                        periodStart: allTimeStart,
                        periodEnd: now,
                    }
                });
            });
        });

        return { success: true };
    }
);
