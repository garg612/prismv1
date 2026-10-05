import { inngest } from "../client";
import prisma from "@/lib/db";
import crypto from 'crypto';

export const exportDataset = inngest.createFunction(
    { id: "export-dataset", triggers: [{ event: "ml.dataset.export_requested" }] },
    async ({ step }) => {
        const dataset = await step.run("build-dataset", async () => {
            const classifications = await prisma.findingClassification.findMany({
                include: {
                    finding: {
                        include: {
                            feedback: true,
                            fixes: {
                                include: {
                                    validationRuns: {
                                        include: { validationResults: true }
                                    }
                                }
                            }
                        }
                    }
                }
            });

            const records: any[] = [];
            for (const c of classifications) {
                // 1. De-identify
                const finding = c.finding;
                if (!finding) continue;

                // 2. Compute labels deterministically
                let label = "UNKNOWN";

                // Feedback takes precedence
                const hasRejectFeedback = finding.feedback.some(fb => fb.kind === 'FIX_REJECTED' || fb.kind === 'FALSE_POSITIVE');
                const hasAcceptFeedback = finding.feedback.some(fb => fb.kind === 'FIX_ACCEPTED' || fb.kind === 'TRUE_POSITIVE');
                
                if (hasRejectFeedback) {
                    label = "FALSE_POSITIVE";
                } else if (hasAcceptFeedback) {
                    label = "TRUE_POSITIVE";
                } else if (finding.fixes.some(fix => fix.outcome === 'FIXED' || fix.status === 'IMPLEMENTED')) {
                    label = "FIXED";
                } else if (finding.fixes.some(fix => fix.outcome === 'NOT_FIXED')) {
                    label = "NOT_FIXED";
                } else {
                    label = c.finalDecision; // SURFACE or SUPPRESS
                }

                // Append-only safe feature extraction
                records.push({
                    featureSnapshot: c.featureSnapshot,
                    score: c.score,
                    modelName: c.modelName,
                    modelVersion: c.modelVersion,
                    policyVersion: c.policyVersion,
                    label,
                    // NO raw code, NO secrets, NO user ids, NO repos
                    timestamp: c.createdAt.toISOString()
                });
            }

            const labelDistribution = records.reduce((acc, r) => {
                acc[r.label] = (acc[r.label] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);

            const payload = {
                datasetVersion: "1.0.0",
                modelFeatureSchemaVersion: "1.0",
                createdAt: new Date().toISOString(),
                rowCount: records.length,
                labelDistribution,
                records
            };

            const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            return { ...payload, checksum };
        });

        // Normally we'd upload to S3 or a blob store, but here we just return it or save to a file for evaluation
        await step.run("save-dataset", async () => {
            // For now, we will just return the payload
            // A realistic implementation would save to blob storage
            console.log(`Dataset generated with checksum: ${dataset.checksum}`);
        });

        return { success: true, checksum: dataset.checksum, rowCount: dataset.rowCount, dataset };
    }
);
