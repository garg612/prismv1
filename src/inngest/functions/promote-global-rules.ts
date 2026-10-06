import { inngest } from "../client";
import prisma from "@/lib/db";

export const promoteGlobalRules = inngest.createFunction(
    { id: "promote-global-rules", triggers: [{ event: "rules.promote" }, { cron: "0 0 * * *" }] },
    async ({ step }) => {
        await step.run("aggregate-and-promote", async () => {
            // Find all active repository-scoped rules
            // We need to group by ruleId and fingerprint, and count unique userIds
            
            // Prisma doesn't easily do COUNT DISTINCT across relations in groupBy, 
            // so we can fetch the active rules and do it in memory since the volume isn't huge yet,
            // or use queryRaw. Let's use queryRaw for efficiency.
            
            const results = await prisma.$queryRaw<Array<{ ruleId: string; fingerprint: string; action: string; uniqueAccounts: bigint }>>`
                SELECT 
                    fr."ruleId", 
                    fr."fingerprint", 
                    fr."action", 
                    COUNT(DISTINCT r."userId") as "uniqueAccounts"
                FROM "feedbackRule" fr
                JOIN "repository" r ON fr."repositoryId" = r."id"
                WHERE fr."scope" = 'REPOSITORY' 
                  AND fr."status" = 'ACTIVE'
                GROUP BY fr."ruleId", fr."fingerprint", fr."action"
                HAVING COUNT(DISTINCT r."userId") >= 5
            `;

            for (const row of results) {
                // Upsert a GLOBAL rule in PENDING state
                const existing = await prisma.feedbackRule.findFirst({
                    where: {
                        scope: 'GLOBAL',
                        ruleId: row.ruleId,
                        fingerprint: row.fingerprint || null
                    }
                });

                if (existing) {
                    await prisma.feedbackRule.update({
                        where: { id: existing.id },
                        data: {
                            accountCount: Number(row.uniqueAccounts)
                        }
                    });
                } else {
                    await prisma.feedbackRule.create({
                        data: {
                            scope: 'GLOBAL',
                            ruleId: row.ruleId,
                            fingerprint: row.fingerprint || null,
                            repositoryId: null,
                            action: row.action as any,
                            status: 'PENDING',
                            accountCount: Number(row.uniqueAccounts)
                        }
                    });
                }
            }
            
            return { promoted: results.length };
        });

        return { success: true };
    }
);
