import prisma from "@/lib/db";
import { generateFingerprint } from "@/modules/scanners/semgrep/fingerprint";
import type { LogicReviewResult } from "./run";
import { LOGIC_REVIEW_SOURCE, LOGIC_REVIEW_VERSION } from "./schema";

/**
 * Store the outcome of a logic review for one review run.
 *
 * The review is recorded as its own scan run (source CUSTOM) so the page can tell "ran and found
 * nothing" from "did not complete" from "was not requested". Its issues are findings with no triage
 * decision: the tool pipeline (triage, automatic fixes, re-scans) selects on that decision and so
 * never picks them up.
 *
 * Safe to call again for the same run: the scan run is reused and findings are upserted.
 */
export async function recordLogicReview(reviewRunId: string, result: LogicReviewResult, startedAt: Date): Promise<{ scanRunId: string; issues: number }> {
    const diagnostics = result.ok
        ? {
            ...(Object.keys(result.discarded).length > 0 ? { discarded: result.discarded } : {}),
            ...(result.coverage.overBudgetFiles.length > 0 ? { notReviewedTooLarge: result.coverage.overBudgetFiles.slice(0, 50) } : {}),
        }
        : { code: result.code, error: result.error };

    const data = {
        toolVersion: result.model,
        rulesetId: LOGIC_REVIEW_VERSION,
        status: (result.ok ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
        scannedFiles: result.coverage.reviewedFiles.length,
        skippedFiles: result.coverage.overBudgetFiles.length,
        toolErrors: Object.keys(diagnostics).length > 0 ? (diagnostics as any) : undefined,
        startedAt,
        finishedAt: new Date(),
    };

    const existing = await prisma.scanRun.findFirst({ where: { reviewRunId, source: LOGIC_REVIEW_SOURCE, kind: "HEAD" } });
    const scanRun = existing
        ? await prisma.scanRun.update({ where: { id: existing.id }, data })
        : await prisma.scanRun.create({ data: { reviewRunId, kind: "HEAD", source: LOGIC_REVIEW_SOURCE, ...data } });

    if (!result.ok) return { scanRunId: scanRun.id, issues: 0 };

    const occurrences = new Map<string, number>();
    for (const issue of result.issues) {
        const ruleId = `logic/${issue.category}`;
        const fingerprint = generateFingerprint(ruleId, issue.filePath, issue.codeSnippet);
        const occurrence = (occurrences.get(fingerprint) || 0) + 1;
        occurrences.set(fingerprint, occurrence);

        const fields = {
            scanRunId: scanRun.id,
            ruleId,
            ruleName: issue.title,
            category: "CORRECTNESS" as const,
            severity: issue.severity,
            confidence: issue.confidence,
            message: issue.explanation,
            filePath: issue.filePath,
            startLine: issue.startLine,
            endLine: issue.endLine,
            codeSnippet: issue.codeSnippet,
            inChangedLines: true,
            isPreexisting: false,
            metadata: { logicReview: { suggestion: issue.suggestion, model: result.model, version: LOGIC_REVIEW_VERSION } },
        };

        await prisma.finding.upsert({
            where: { reviewRunId_source_fingerprint_occurrence: { reviewRunId, source: LOGIC_REVIEW_SOURCE, fingerprint, occurrence } },
            update: fields,
            // No triage decision and no automatic fix: these are advisory and reviewed by a person.
            create: { reviewRunId, source: LOGIC_REVIEW_SOURCE, fingerprint, occurrence, status: "NO_AUTOFIX", ...fields },
        });
    }

    return { scanRunId: scanRun.id, issues: result.issues.length };
}
