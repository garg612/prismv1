import prisma from "@/lib/db";
import { buildReviewView, LatestRunInput, ReviewView } from "./review-view";

const MAX_SUPERSEDE_HOPS = 25;

/** Follow supersededById to the newest review of the same pull request. */
async function findLatestRun(firstId: string | null): Promise<LatestRunInput | null> {
    let nextId = firstId;
    let latest: LatestRunInput | null = null;
    for (let hop = 0; nextId && hop < MAX_SUPERSEDE_HOPS; hop++) {
        const next: (LatestRunInput & { supersededById: string | null }) | null = await prisma.reviewRun.findUnique({
            where: { id: nextId },
            select: { id: true, status: true, headSha: true, supersededById: true, findings: { select: { fingerprint: true } } }
        });
        if (!next) break;
        latest = { id: next.id, status: next.status, headSha: next.headSha, findings: next.findings };
        nextId = next.supersededById;
    }
    return latest;
}

export interface LoadedReview {
    pullRequest: { number: number; title: string; url: string };
    repository: { owner: string; name: string };
    headSha: string;
    /** When this review last changed */
    updatedAt: Date;
    view: ReviewView;
}

/**
 * Load one review run for the page. Returns null when the run does not exist or
 * does not belong to `userId`, so the caller cannot tell the two apart.
 */
export async function loadReview(reviewRunId: string, userId: string): Promise<LoadedReview | null> {
    const run = await prisma.reviewRun.findFirst({
        where: { id: reviewRunId, repository: { userId } },
        include: {
            pullRequest: true,
            repository: true,
            scanRuns: true,
            findings: {
                orderBy: [{ severity: "desc" }, { filePath: "asc" }, { startLine: "asc" }],
                include: {
                    classifications: true,
                    feedback: { where: { userId }, select: { kind: true, createdAt: true } },
                    fixes: {
                        include: {
                            patch: true,
                            applyAttempts: true,
                            validationRuns: { include: { validationResults: true, findingDeltas: true } }
                        }
                    }
                }
            }
        }
    });
    if (!run) return null;

    // The earlier reviews of the same pull request, for the current review only: it is the one
    // that can confirm fixes applied after an earlier review.
    const [latestRun, earlierRuns] = await Promise.all([
        findLatestRun(run.supersededById),
        run.status === "SUPERSEDED" ? Promise.resolve([]) : prisma.reviewRun.findMany({
            where: { pullRequestId: run.pullRequestId, id: { not: run.id }, status: "SUPERSEDED" },
            select: {
                id: true, headSha: true, updatedAt: true,
                findings: {
                    where: { triageDecision: "SURFACE" },
                    select: { source: true, fingerprint: true, triageDecision: true, fixes: { select: { status: true, applyAttempts: { select: { status: true, mode: true, resultPrUrl: true } } } } },
                },
            },
        }),
    ]);

    return {
        pullRequest: { number: run.pullRequest.number, title: run.pullRequest.title, url: run.pullRequest.url },
        repository: { owner: run.repository.owner, name: run.repository.name },
        headSha: run.headSha,
        updatedAt: run.updatedAt,
        view: buildReviewView(run, latestRun, Date.now(), earlierRuns)
    };
}
