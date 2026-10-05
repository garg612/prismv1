import prisma from "@/lib/db";
import { LOGIC_REVIEW_SOURCE } from "@/modules/logic-review/lib/schema";

export const FEEDBACK_ACTIONS = ["TRUE_POSITIVE", "FALSE_POSITIVE", "CLEAR", "UNSUPPRESS"] as const;
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

export type FeedbackResult =
    | { ok: true; verdict: "REAL" | "FALSE_ALARM" | null; unsuppressed: boolean }
    | { ok: false; status: 404 | 409; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A review in one of these states is finished, so a manual change cannot race the pipeline. */
const SETTLED_RUN = ["AWAITING_APPROVAL", "COMPLETED"];

/**
 * Record what `userId` says about a finding. The finding must be in a repository that user owns;
 * a finding that does not exist and one that belongs to someone else give the same answer.
 *
 * An answer replaces the previous one, so answering again (or a thousand times) leaves exactly
 * one answer for this finding and this user.
 */
export async function recordFeedback(userId: string, findingId: string, action: FeedbackAction): Promise<FeedbackResult> {
    const notFound: FeedbackResult = { ok: false, status: 404, error: "Finding not found" };
    if (!UUID.test(findingId)) return notFound;

    const finding = await prisma.finding.findFirst({
        where: { id: findingId, reviewRun: { repository: { userId } } },
        select: { id: true, source: true, triageDecision: true, reviewRunId: true, reviewRun: { select: { status: true } } },
    });
    if (!finding) return notFound;

    // AI logic suggestions are optional reading. No answers are collected for them.
    if (finding.source === LOGIC_REVIEW_SOURCE) {
        return { ok: false, status: 409, error: "Feedback is not collected for AI suggestions." };
    }

    if (action === "UNSUPPRESS") {
        // Both "not shown" outcomes of triage can be brought back.
        const previous = finding.triageDecision;
        if (previous !== "SUPPRESS" && previous !== "UNCERTAIN") {
            return { ok: false, status: 409, error: "This issue is not filtered out." };
        }
        if (!SETTLED_RUN.includes(finding.reviewRun.status)) {
            return { ok: false, status: 409, error: "This review is not the current, finished review of the pull request, so the issue cannot be changed here." };
        }
        const changed = await prisma.$transaction(async tx => {
            // Only the request that actually flips the finding records the override.
            const flipped = await tx.finding.updateMany({ where: { id: finding.id, triageDecision: previous }, data: { triageDecision: "SURFACE" } });
            if (flipped.count === 0) return false;
            await tx.findingClassification.create({
                data: {
                    findingId: finding.id, modelName: "policy-override", modelVersion: "N/A", score: 0,
                    modelDecision: previous, finalDecision: "SURFACE", decisionSource: "OVERRIDE",
                    reasonCodes: ["USER_UNSUPPRESS"], reasonText: "Brought back by the repository owner", isShadow: false,
                },
            });
            await tx.findingFeedback.upsert({
                where: { findingId_userId_kind: { findingId: finding.id, userId, kind: "UNSUPPRESS_REQUEST" } },
                create: { findingId: finding.id, userId, kind: "UNSUPPRESS_REQUEST" },
                update: {},
            });
            await tx.reviewRun.update({ where: { id: finding.reviewRunId }, data: { surfacedCount: { increment: 1 }, suppressedCount: { decrement: previous === "SUPPRESS" ? 1 : 0 } } });
            return true;
        });
        if (!changed) return { ok: false, status: 409, error: "This issue is not filtered out." };
        return { ok: true, verdict: null, unsuppressed: true };
    }

    const where = { findingId: finding.id, userId };
    if (action === "CLEAR") {
        await prisma.findingFeedback.deleteMany({ where: { ...where, kind: { in: ["TRUE_POSITIVE", "FALSE_POSITIVE"] } } });
        return { ok: true, verdict: null, unsuppressed: false };
    }

    const other = action === "TRUE_POSITIVE" ? "FALSE_POSITIVE" : "TRUE_POSITIVE";
    await prisma.$transaction([
        prisma.findingFeedback.deleteMany({ where: { ...where, kind: other } }),
        prisma.findingFeedback.upsert({
            where: { findingId_userId_kind: { ...where, kind: action } },
            create: { ...where, kind: action },
            // Re-stamp, so that the newest answer is always the one that counts.
            update: { createdAt: new Date() },
        }),
    ]);
    return { ok: true, verdict: action === "FALSE_POSITIVE" ? "FALSE_ALARM" : "REAL", unsuppressed: false };
}
