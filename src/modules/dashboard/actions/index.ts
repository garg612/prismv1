"use server"

import { fetchUserContribution, getGithubToken } from "@/modules/github/lib/github"
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { Octokit } from "octokit";
import prisma from "@/lib/db";

export async function getContributionStats() {
    try {
        const session = await auth.api.getSession({
            headers: await headers(),
        })

        if (!session?.user) {
            throw new Error("Unauthorized")
        }

        const token = await getGithubToken()

        let username = "demo_user";
        if (process.env.NEXT_PUBLIC_DEMO_MODE !== "true") {
            const octokit = new Octokit({ auth: token })
            const { data: user } = await octokit.rest.users.getAuthenticated()
            username = user.login;
        }

        const calendar = await fetchUserContribution(token, username);

        if (!calendar) {
            return null
        }

         
        const contributions = calendar.weeks.flatMap((week: any) => week.contributionDays)
             
            .map((day: any) => ({
                date: day.date,
                count: day.contributionCount,
                level: Math.min(4, Math.floor(day.contributionCount / 3)),
            }))

        return {
            contributions: contributions,
            totalContributions: calendar.totalContributions
        }

    } catch (err) {
        console.error("[getContributionStats] Failed:", err)
        return null
    }
}

export async function getDashboardStats() {
    try {
        const session = await auth.api.getSession({
            headers: await headers()
        })
        if (!session?.user) {
            throw new Error("Unauthorized")
        }

        const userId = session.user.id;

        // Fetch total connected repos from DB
        const totalRepos = await prisma.repository.count({
            where: { userId }
        })

        // 1. Total meaningful reviews
        const totalReviews = await prisma.reviewRun.count({
            where: {
                repository: { userId },
                status: { in: ['COMPLETED', 'AWAITING_APPROVAL', 'REPORTING'] },
                supersededById: null,
            },
        });

        // 2. Unique findings analyzed (dedupe by PR + fingerprint)
        const uniqueFindingsRes = await prisma.$queryRaw<[{ count: bigint }]>`
            SELECT COUNT(*) as count FROM (
                SELECT DISTINCT pr."id", f."fingerprint"
                FROM "finding" f
                JOIN "reviewRun" rr ON f."reviewRunId" = rr."id"
                JOIN "pullRequest" pr ON rr."pullRequestId" = pr."id"
                JOIN "repository" r ON rr."repositoryId" = r."id"
                WHERE r."userId" = ${userId}
                  AND f."source" != 'CUSTOM'
            ) sub
        `;
        const findingsAnalyzed = Number(uniqueFindingsRes[0]?.count || 0);

        // 3. Findings surfaced — latest decision per PR+fingerprint
        const surfacedFindingsRes = await prisma.$queryRaw<[{ count: bigint }]>`
            SELECT COUNT(*) as count FROM (
                SELECT DISTINCT ON (pr."id", f."fingerprint")
                    f."triageDecision"
                FROM "finding" f
                JOIN "reviewRun" rr ON f."reviewRunId" = rr."id"
                JOIN "pullRequest" pr ON rr."pullRequestId" = pr."id"
                JOIN "repository" r ON rr."repositoryId" = r."id"
                WHERE r."userId" = ${userId}
                  AND f."source" != 'CUSTOM'
                ORDER BY pr."id", f."fingerprint", rr."startedAt" DESC NULLS LAST
            ) sub
            WHERE sub."triageDecision" = 'SURFACE'
        `;
        const findingsSurfaced = Number(surfacedFindingsRes[0]?.count || 0);

        // 4. Fixes — latest attempt per finding only
        const fixStatsRes = await prisma.$queryRaw<[{ fixesGenerated: bigint, fixesReady: bigint }]>`
            SELECT
                COUNT(*) FILTER (WHERE sf."patch" = true) as "fixesGenerated",
                COUNT(*) FILTER (WHERE sf."status" = 'READY') as "fixesReady"
            FROM (
                SELECT DISTINCT ON (sf."findingId") sf.*,
                    CASE WHEN p."id" IS NOT NULL THEN true ELSE false END as "patch"
                FROM "suggestedFix" sf
                LEFT JOIN "patch" p ON p."suggestedFixId" = sf."id"
                JOIN "finding" f ON sf."findingId" = f."id"
                JOIN "reviewRun" rr ON f."reviewRunId" = rr."id"
                JOIN "repository" r ON rr."repositoryId" = r."id"
                WHERE r."userId" = ${userId}
                ORDER BY sf."findingId", sf."attempt" DESC
            ) sf
        `;
        const fixesGenerated = Number(fixStatsRes[0]?.fixesGenerated || 0);
        const fixesReady = Number(fixStatsRes[0]?.fixesReady || 0);

        // 5. Accepted/Rejected via FindingFeedback
        const [fixesAccepted, fixesRejected] = await Promise.all([
            prisma.findingFeedback.count({
                where: { kind: 'FIX_ACCEPTED', finding: { reviewRun: { repository: { userId } } } },
            }),
            prisma.findingFeedback.count({
                where: { kind: 'FIX_REJECTED', finding: { reviewRun: { repository: { userId } } } },
            }),
        ]);

        // 6. Fixes applied — distinct suggestedFixId
        const fixesAppliedRes = await prisma.$queryRaw<[{ count: bigint }]>`
            SELECT COUNT(DISTINCT aa."suggestedFixId") as count
            FROM "applyAttempt" aa
            JOIN "suggestedFix" sf ON aa."suggestedFixId" = sf."id"
            JOIN "finding" f ON sf."findingId" = f."id"
            JOIN "reviewRun" rr ON f."reviewRunId" = rr."id"
            JOIN "repository" r ON rr."repositoryId" = r."id"
            WHERE aa."status" = 'SUCCEEDED' AND r."userId" = ${userId}
        `;
        const fixesApplied = Number(fixesAppliedRes[0]?.count || 0);

        // 7. Total PRs for coverage metric
        const totalPRs = await prisma.pullRequest.count({
            where: { repository: { userId } }
        });

        return {
            totalRepos,
            totalReviews,
            totalPRs,
            findingsAnalyzed,
            findingsSurfaced,
            fixesGenerated,
            fixesReady,
            fixesAccepted,
            fixesRejected,
            fixesApplied
        }

    } catch (err) {
        console.log("[getDashboardStats] Error:", err)
        return {
            totalRepos: 0,
            totalReviews: 0,
            totalPRs: 0,
            findingsAnalyzed: 0,
            findingsSurfaced: 0,
            fixesGenerated: 0,
            fixesReady: 0,
            fixesAccepted: 0,
            fixesRejected: 0,
            fixesApplied: 0
        }
    }
}

export async function getGlobalMetricHistory() {
    try {
        const session = await auth.api.getSession({
            headers: await headers()
        })
        if (!session?.user) {
            throw new Error("Unauthorized")
        }

        const snapshots = await prisma.globalMetricSnapshot.findMany({
            where: { metric: { in: ['FALSE_ALARM_RATE', 'FIX_ACCEPTANCE_RATE'] } },
            orderBy: { createdAt: 'asc' },
            take: 200,
        });

        return snapshots;
    } catch (err) {
        console.log("[getGlobalMetricHistory] Error:", err);
        return [];
    }
}

export async function getMonthlyActivity() {
    try {
        const session = await auth.api.getSession({
            headers: await headers()
        })
        if (!session?.user) {
            throw new Error("Unauthorized")
        }

        const token = await getGithubToken()
        const octokit = new Octokit({ auth: token })

        const { data: user } = process.env.NEXT_PUBLIC_DEMO_MODE === "true" 
            ? { data: { login: "demo-user" } } 
            : await octokit.rest.users.getAuthenticated()

        const calendar = await fetchUserContribution(token, user.login)

        if (!calendar) {
            throw new Error("Failed to fetch user contribution")
        }

        const monthlyData: {
            [key: string]: {
                commits: number;
                prs: number;
                reviews: number
            }
        } = {}

        const monthNames = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec"
        ];

        //initalizing 6 months
        const now = new Date();

        for (let i = 5; i >= 0; i--) {
            const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthKey = monthNames[date.getMonth()];
            monthlyData[monthKey] = { commits: 0, prs: 0, reviews: 0 };
        }

         
        calendar.weeks.forEach((week: any) => {
             
            week.contributionDays.forEach((day: any) => {
                const date = new Date(day.date);
                const monthKey = monthNames[date.getMonth()];
                if (monthlyData[monthKey]) {
                    monthlyData[monthKey].commits += day.contributionCount;
                }
            })
        })

        // Fetch real reviews from database for last 6 months
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        const reviews = await prisma.review.findMany({
            where: {
                repository: {
                    userId: session.user.id
                },
                createdAt: {
                    gte: sixMonthsAgo
                }
            },
            select: {
                createdAt: true
            }
        })

        reviews.forEach((review) => {
            const monthKey = monthNames[review.createdAt.getMonth()];
            if (monthlyData[monthKey]) {
                monthlyData[monthKey].reviews += 1;
            }
        })

        if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
            Object.keys(monthlyData).forEach(key => {
                monthlyData[key].prs = Math.floor(Math.random() * 10) + 1;
            });
        } else {
            const { data: prs } = await octokit.rest.search.issuesAndPullRequests({
                q: `author:${user.login} type:pr created:>${sixMonthsAgo.toISOString().split("T")[0]}`,
                per_page: 100,
            });

             
            prs.items.forEach((pr: any) => {
                const date = new Date(pr.created_at);
                const monthKey = monthNames[date.getMonth()];
                if (monthlyData[monthKey]) {
                    monthlyData[monthKey].prs += 1;
                }
            });
        }

        return Object.keys(monthlyData).map((name) => ({
            name,
            ...monthlyData[name]
        }))


    } catch (err) {
        console.log(err);
        return [];
    }
}

