import { inngest } from "../client";
import { generateObject } from "ai";
import { getReportModel } from "@/lib/ai";
import { z } from "zod";
import prisma from "@/lib/db";
import { LOGIC_REVIEW_SOURCE } from "@/modules/logic-review/lib/schema";

/** Keeps model-written text from breaking the Markdown list it is placed in. */
const oneLine = (text: string, max: number) => String(text || "").replace(/\s+/g, " ").replace(/[`|<>]/g, "").trim().slice(0, max);

const ReportNarrativeSchema = z.object({
    summary: z.string().describe("Executive summary of the PR and findings"),
    whyItMatters: z.string().describe("Why the findings are important"),
    riskNotes: z.string().describe("Any operational or security risks if not fixed")
});

function logicReviewSection(logic: { completed: boolean; reviewedFiles: number; issues: Array<{ title: string; filePath: string; startLine: number; severity: string }> } | null): string {
    if (!logic) return "";
    const heading = "\n### Possible logic issues (AI review)\n";
    if (!logic.completed) {
        return `${heading}The AI logic review did not complete for this commit, so it has no result. This is not a clean result.\n`;
    }
    if (logic.issues.length === 0) {
        return `${heading}None found in the ${logic.reviewedFiles} changed code ${logic.reviewedFiles === 1 ? "file" : "files"} reviewed.\n`;
    }
    const lines = logic.issues.map(i => `- **${oneLine(i.title, 160)}** (${oneLine(i.filePath, 200)}:${i.startLine}, ${String(i.severity).toLowerCase()} severity)`);
    return `${heading}${lines.join("\n")}\n\n*Suggested by AI from the diff. Not verified by a tool and not fixed automatically; please check each one.*\n`;
}

export const generateReport = inngest.createFunction(
    { id: "generate-report", triggers: [{ event: "review.report.requested" }] },
    async ({ event, step }: { event: any, step: any }) => {
    const { reviewRunId } = event.data;

    const reportData = await step.run("gather-data", async () => {
        const reviewRun = await prisma.reviewRun.findUnique({
            where: { id: reviewRunId },
            include: {
                findings: {
                    include: { fixes: true, classifications: true }
                },
                pullRequest: true,
                scanRuns: true,
                validationRuns: {
                    include: { validationResults: true, findingDeltas: true }
                }
            }
        });
        
        if (!reviewRun) throw new Error("ReviewRun not found");

        const surfacedFindings = reviewRun.findings.filter(f => f.triageDecision === 'SURFACE');
        
        const deterministicStats = {
            totalFindings: reviewRun.totalFindings,
            surfacedCount: surfacedFindings.length,
            fixesGenerated: surfacedFindings.filter(f => f.fixes.length > 0).length,
            fixesReady: surfacedFindings.filter(f => f.fixes.some(x => x.status === 'READY')).length,
            fixesFailed: surfacedFindings.filter(f => f.fixes.some(x => x.status === 'NOT_READY')).length,
            validationChecks: {
                STATIC: "UNAVAILABLE",
                TESTS: "UNAVAILABLE"
            }
        };

        if (reviewRun.validationRuns.length > 0) {
            deterministicStats.validationChecks.STATIC = "COMPLETED";
            // Tests not run in static tier
        }

        // Logic review: reported in its own section, never counted with scanner findings.
        const logicScan = reviewRun.scanRuns.find(s => s.source === LOGIC_REVIEW_SOURCE);
        const logicReview = logicScan
            ? {
                completed: logicScan.status === "COMPLETED",
                reviewedFiles: logicScan.scannedFiles ?? 0,
                issues: reviewRun.findings
                    .filter(f => f.source === LOGIC_REVIEW_SOURCE)
                    .map(f => ({ title: f.ruleName || f.ruleId, filePath: f.filePath, startLine: f.startLine, severity: f.severity }))
            }
            : null;

        return { reviewRun, surfacedFindings, deterministicStats, logicReview };
    });

    const narrative = await step.run("generate-narrative", async () => {
        const { reviewRun, surfacedFindings, deterministicStats } = reportData;
        
        if (surfacedFindings.length === 0) {
            return {
                summary: "Automated code review completed.",
                whyItMatters: "Clean code reduces technical debt and prevents future bugs.",
                riskNotes: "No actionable security or code quality risks were identified."
            };
        }

        const prompt = `Generate a code review report narrative for PR: ${reviewRun.pullRequest.title}
Stats:
${JSON.stringify(deterministicStats, null, 2)}
Surfaced Findings:
${surfacedFindings.map((f: any) => `- ${f.ruleId} in ${f.filePath}: ${f.message}`).join('\n')}

Only use the deterministic stats above.
Return a valid JSON matching the schema.`;

        try {
            const { object } = await generateObject({
                model: getReportModel(),
                schema: ReportNarrativeSchema,
                prompt
            });

            return object;
        } catch (e: any) {
            return {
                summary: "Automated analysis completed.",
                whyItMatters: "Security and code quality findings were surfaced.",
                riskNotes: "Please review the findings below."
            };
        }
    });

    await step.run("save-report", async () => {
        const reportJson = {
            narrative,
            stats: reportData.deterministicStats
        };

        const markdownText = `${narrative.summary}

### Why It Matters
${narrative.whyItMatters}

### Risk Notes
${narrative.riskNotes}

${logicReviewSection(reportData.logicReview)}`;

        const existingReview = await prisma.review.findUnique({
            where: { reviewRunId }
        });

        if (existingReview) {
            await prisma.review.update({
                where: { reviewRunId },
                data: {
                    review: markdownText,
                    reportJson: reportJson,
                    reportSchemaVersion: 1
                }
            });
        } else {
            await prisma.review.create({
                data: {
                    repositoryId: reportData.reviewRun.repositoryId,
                    prNumber: reportData.reviewRun.pullRequest.number,
                    prTitle: reportData.reviewRun.pullRequest.title,
                    prUrl: reportData.reviewRun.pullRequest.url,
                    reviewRunId: reviewRunId,
                    review: markdownText,
                    reportJson: reportJson,
                    reportSchemaVersion: 1
                }
            });
        }
    });

    return { success: true };
});
