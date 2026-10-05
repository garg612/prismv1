import prisma from "@/lib/db";
import { buildReviewList, ReviewListItem } from "./review-list";

/** The newest reviews are loaded; older ones are reachable from their pull request's row. */
export const REVIEW_LIST_LIMIT = 200;

export interface LoadedReviewList {
    items: ReviewListItem[];
    /** True when the account has more reviews than were loaded */
    truncated: boolean;
}

/** Reviews of the repositories `userId` owns, grouped per pull request. */
export async function loadReviewList(userId: string): Promise<LoadedReviewList> {
    const runs = await prisma.reviewRun.findMany({
        where: { repository: { userId } },
        orderBy: { updatedAt: "desc" },
        take: REVIEW_LIST_LIMIT + 1,
        select: {
            id: true, status: true, headSha: true, updatedAt: true,
            pullRequest: { select: { id: true, number: true, title: true, url: true } },
            repository: { select: { owner: true, name: true } },
            findings: { select: { source: true, fingerprint: true, occurrence: true, triageDecision: true, fixes: { select: { status: true } } } },
        },
    });
    const truncated = runs.length > REVIEW_LIST_LIMIT;
    return { items: buildReviewList(truncated ? runs.slice(0, REVIEW_LIST_LIMIT) : runs), truncated };
}
