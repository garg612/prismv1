"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { headers } from "next/headers";
import { getGithubToken } from "@/modules/github/lib/github";
import { Octokit } from "octokit";
import { applyFixToGithub, DeliveryMode } from "@/modules/github/lib/apply-fix";
import crypto from "crypto";
import { FIX_DECISION_LIMIT, rateLimit } from "@/lib/rate-limit";

const TOO_MANY = { success: false as const, error: "Too many requests. Try again in a minute." };

/** One decision row per fix decision kind, however often the action is repeated. */
function recordFixDecision(findingId: string, suggestedFixId: string, userId: string, kind: "FIX_ACCEPTED" | "FIX_REJECTED") {
    return prisma.findingFeedback.upsert({
        where: { findingId_userId_kind: { findingId, userId, kind } },
        create: { findingId, suggestedFixId, userId, kind },
        update: { suggestedFixId },
    });
}

export async function acceptFix(fixId: string) {
    // 1. Authenticate session
    const session = await auth.api.getSession({
        headers: await headers()
    });
    if (!session) {
        return { success: false, error: "UNAUTHORIZED" };
    }
    if (!rateLimit(`fix-decision:${session.user.id}`, FIX_DECISION_LIMIT).allowed) return TOO_MANY;

    // 2. Fetch the fix and related entities
    const fix = await prisma.suggestedFix.findUnique({
        where: { id: fixId },
        include: {
            finding: {
                include: {
                    reviewRun: {
                        include: {
                            pullRequest: true,
                            repository: true
                        }
                    }
                }
            },
            patch: true
        }
    });

    if (!fix || !fix.patch) {
        return { success: false, error: "FIX_NOT_FOUND" };
    }

    const { finding } = fix;
    const { reviewRun } = finding;
    const { repository, pullRequest } = reviewRun;

    // 3. Verify ownership
    if (repository.userId !== session.user.id) {
        return { success: false, error: "FORBIDDEN" };
    }

    // 4. Verify AWAITING_APPROVAL and reportJson existence
    if (reviewRun.status !== "AWAITING_APPROVAL") {
        return { success: false, error: "INVALID_REVIEW_STATE" };
    }

    const review = await prisma.review.findUnique({ where: { reviewRunId: reviewRun.id } });
    if (!review || !review.reportJson) {
        return { success: false, error: "MISSING_REPORT" };
    }

    // 5. Verify fix is READY, or failed to apply earlier (a failed apply changes nothing, so it can be retried)
    if (fix.status !== "READY" && fix.status !== "IMPLEMENT_FAILED") {
        return { success: false, error: "FIX_NOT_READY" };
    }

    // 6. Expiry check
    if (fix.expiresAt && fix.expiresAt < new Date()) {
        await prisma.suggestedFix.update({ where: { id: fix.id }, data: { status: "EXPIRED" } });
        return { success: false, error: "Fix expired â€” re-run the review." };
    }

    // 7. Conditional Idempotent Apply Lock (CAS transition READY | IMPLEMENT_FAILED -> IMPLEMENTING)
    const idempotencyKey = crypto.randomUUID();
    
    // We only create an apply attempt if the transition succeeds
    const updatedFix = await prisma.suggestedFix.updateMany({
        where: {
            id: fix.id,
            status: fix.status
        },
        data: {
            status: "IMPLEMENTING"
        }
    });

    if (updatedFix.count === 0) {
        return { success: false, error: "FIX_ALREADY_PROCESSING" };
    }

    // Create the ApplyAttempt
    const mode = (repository.fixDeliveryMode as DeliveryMode) || "FIX_BRANCH_PR";
    
    const applyAttempt = await prisma.applyAttempt.create({
        data: {
            suggestedFixId: fix.id,
            userId: session.user.id,
            mode: mode,
            status: "PENDING",
            idempotencyKey,
            expectedHeadSha: fix.validatedHeadSha || reviewRun.headSha
        }
    });

    try {
        // 8. Fetch current PR head SHA
        const token = await getGithubToken();
        const octokit = new Octokit({ auth: token });

        const { data: githubPr } = await octokit.rest.pulls.get({
            owner: repository.owner,
            repo: repository.name,
            pull_number: pullRequest.number
        });

        const currentHeadSha = githubPr.head.sha;

        if (currentHeadSha !== fix.validatedHeadSha && currentHeadSha !== reviewRun.headSha) {
            // SHA differs -> STALE
            await prisma.suggestedFix.update({ where: { id: fix.id }, data: { status: "STALE" } });
            await prisma.applyAttempt.update({
                where: { id: applyAttempt.id },
                data: {
                    status: "REJECTED_STALE",
                    observedHeadSha: currentHeadSha,
                    error: "Out of date â€” this fix was validated against an older commit. PRism has started re-analysis."
                }
            });
            return { success: false, error: "Out of date â€” this fix was validated against an older commit. PRism has started re-analysis." };
        }

        // 9. Blob Re-check & Apply
        const applyResult = await applyFixToGithub(octokit, mode, repository, pullRequest, fix, fix.patch);

        if (!applyResult.success) {
            let nextFixStatus: any = "IMPLEMENT_FAILED";
            let applyStatus: any = "FAILED";
            
            if (applyResult.error === "BLOB_MISMATCH") {
                nextFixStatus = "STALE";
                applyStatus = "REJECTED_STALE";
            }

            await prisma.applyAttempt.update({
                where: { id: applyAttempt.id },
                data: {
                    status: applyStatus,
                    error: applyResult.error
                }
            });

            await prisma.suggestedFix.update({
                where: { id: fix.id },
                data: { status: nextFixStatus }
            });

            return { success: false, error: applyResult.error };
        }

        // 10. Success Transition
        await prisma.applyAttempt.update({
            where: { id: applyAttempt.id },
            data: {
                status: "SUCCEEDED",
                resultCommitSha: applyResult.resultCommitSha,
                resultBranch: applyResult.resultBranch,
                resultPrUrl: applyResult.resultPrUrl
            }
        });

        await prisma.suggestedFix.update({
            where: { id: fix.id },
            data: { status: "IMPLEMENTED" }
        });

        await prisma.finding.update({
            where: { id: finding.id },
            data: { status: "ACCEPTED" }
        });

        await recordFixDecision(finding.id, fix.id, session.user.id, "FIX_ACCEPTED");

        // Post a fix-validation report comment
        try {
            const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/dashboard/reviews/${reviewRun.id}`;
            let fixMessage = `✅ **PRism successfully applied a fix** for \`${finding.ruleName || finding.ruleId || "an issue"}\`.\n\n`;
            if (applyResult.resultPrUrl) {
                fixMessage += `🔗 Fix Pull Request: ${applyResult.resultPrUrl}\n`;
            } else if (applyResult.resultCommitSha) {
                fixMessage += `🔗 Fix Commit: ${applyResult.resultCommitSha}\n`;
            }
            fixMessage += `\n**Validation checks passed in isolated environment:**\n` +
                          `- ✅ Code parsed cleanly\n` +
                          `- ✅ Finding was successfully resolved\n` +
                          `- ✅ No new issues introduced\n\n` +
                          `[View details in PRism Dashboard](${dashboardUrl})`;

            await octokit.rest.issues.createComment({
                owner: repository.owner,
                repo: repository.name,
                issue_number: pullRequest.number,
                body: fixMessage
            });
        } catch (e) {
            console.error("Failed to post fix comment to GitHub", e);
        }

        revalidatePath("/dashboard/reviews", "layout"); return { success: true, url: applyResult.resultPrUrl };
    } catch (e: any) {
        console.error("Apply fix error:", e);
        // Fallback for unexpected failures
        await prisma.applyAttempt.update({
            where: { id: applyAttempt.id },
            data: { status: "FAILED", error: e.message }
        });
        await prisma.suggestedFix.update({
            where: { id: fix.id },
            data: { status: "IMPLEMENT_FAILED" }
        });
        return { success: false, error: e.message };
    }
}

export async function rejectFix(fixId: string) {
    const session = await auth.api.getSession({
        headers: await headers()
    });
    if (!session) {
        return { success: false, error: "UNAUTHORIZED" };
    }
    if (!rateLimit(`fix-decision:${session.user.id}`, FIX_DECISION_LIMIT).allowed) return TOO_MANY;

    const fix = await prisma.suggestedFix.findUnique({
        where: { id: fixId },
        include: {
            finding: { include: { reviewRun: { include: { repository: true } } } }
        }
    });

    if (!fix) return { success: false, error: "FIX_NOT_FOUND" };
    const { finding } = fix;
    const { reviewRun } = finding;
    const { repository } = reviewRun;

    if (repository.userId !== session.user.id) {
        return { success: false, error: "FORBIDDEN" };
    }

    if (fix.status !== "READY" && fix.status !== "IMPLEMENT_FAILED") {
        return { success: false, error: "FIX_NOT_READY" };
    }

    // Compare-and-set: a fix that is being applied (or was decided) in the meantime is not overwritten.
    const rejected = await prisma.suggestedFix.updateMany({
        where: { id: fix.id, status: fix.status },
        data: { status: "REJECTED" }
    });
    if (rejected.count === 0) {
        return { success: false, error: "FIX_ALREADY_PROCESSING" };
    }

    await prisma.finding.update({
        where: { id: finding.id },
        data: { status: "REJECTED" }
    });

    await recordFixDecision(finding.id, fix.id, session.user.id, "FIX_REJECTED");

    revalidatePath("/dashboard/reviews", "layout"); return { success: true };
}

import { inngest } from "../../../inngest/client";

export async function acceptReadyFixes(reviewRunId: string, fixIds?: string[]) {
    const session = await auth.api.getSession({
        headers: await headers()
    });
    if (!session) return { success: false, error: "UNAUTHORIZED" };
    if (!rateLimit(`fix-decision:${session.user.id}`, FIX_DECISION_LIMIT).allowed) return TOO_MANY;

    const reviewRun = await prisma.reviewRun.findUnique({
        where: { id: reviewRunId },
        include: { repository: true, pullRequest: true }
    });

    if (!reviewRun) return { success: false, error: "RUN_NOT_FOUND" };
    if (reviewRun.repository.userId !== session.user.id) return { success: false, error: "FORBIDDEN" };
    if (reviewRun.status !== "AWAITING_APPROVAL") return { success: false, error: "INVALID_REVIEW_STATE" };

    let fixes = await prisma.suggestedFix.findMany({
        where: { reviewRunId, status: "READY" }
    });
    
    if (fixIds) {
        fixes = fixes.filter(f => fixIds.includes(f.id));
    }

    if (fixes.length === 0) return { success: false, error: "NO_READY_FIXES" };

    const sortedFixIds = fixes.map(f => f.id).sort();

    // Check if combined validation exists
    const latestCombined = await prisma.validationRun.findFirst({
        where: { reviewRunId, kind: "COMBINED" },
        orderBy: { startedAt: "desc" }
    });

    const isMatch = latestCombined && 
                    latestCombined.headSha === reviewRun.pullRequest.latestHeadSha &&
                    latestCombined.includedFixIds.length === sortedFixIds.length &&
                    latestCombined.includedFixIds.every(id => sortedFixIds.includes(id));

    if (!isMatch || latestCombined.status !== "COMPLETED") {
        // Trigger validation if not match or not finished
        await inngest.send({
            name: "review.combined_validation.requested",
            data: { reviewRunId, fixIds: sortedFixIds }
        });
        return { success: false, error: "Combined validation triggered. Please wait and try again." };
    }

    // Must be successful
    const failedCheck = await prisma.validationResult.findFirst({
        where: { validationRunId: latestCombined.id, status: "FAILED" }
    });

    if (failedCheck) {
        return { success: false, error: "Combined validation failed." };
    }

    // Check expiry
    for (const fix of fixes) {
        if (fix.expiresAt && fix.expiresAt < new Date()) {
            await prisma.suggestedFix.update({ where: { id: fix.id }, data: { status: "EXPIRED" } });
            return { success: false, error: "One or more fixes expired. Re-run analysis." };
        }
    }

    // Retrieve Octokit client
    const account = await prisma.account.findFirst({
        where: { userId: session.user.id, providerId: "github" }
    });
    if (!account?.accessToken) return { success: false, error: "NO_GITHUB_LINK" };
    const octokit = new Octokit({ auth: account.accessToken });

    // Combine edits from all fixes
    const combinedEdits = fixes.flatMap(f => (f.edits as any[]) || []);
    
    // Create a pseudo-fix for the combined application
    const pseudoFix = {
        findingId: "COMBINED",
        edits: combinedEdits,
        validatedHeadSha: latestCombined.headSha
    } as any;

    const mode = (reviewRun.repository.fixDeliveryMode as DeliveryMode) || "FIX_BRANCH_PR";

    // Claim every fix before touching GitHub, so two requests cannot apply the same fixes twice.
    const claimed = await prisma.suggestedFix.updateMany({
        where: { id: { in: sortedFixIds }, status: "READY" },
        data: { status: "IMPLEMENTING" }
    });
    const release = () => prisma.suggestedFix.updateMany({
        where: { id: { in: sortedFixIds }, status: "IMPLEMENTING" },
        data: { status: "READY" }
    });
    if (claimed.count !== sortedFixIds.length) {
        await release();
        return { success: false, error: "FIX_ALREADY_PROCESSING" };
    }

    try {
        const result = await applyFixToGithub(
            octokit,
            mode,
            reviewRun.repository,
            reviewRun.pullRequest,
            pseudoFix,
            null as any // Patch isn't directly used for edits in Stage 7 apply
        );

        if (result.success) {
            for (const fix of fixes) {
                await prisma.suggestedFix.update({
                    where: { id: fix.id },
                    data: { status: "IMPLEMENTED" }
                });
                await prisma.finding.update({
                    where: { id: fix.findingId },
                    data: { status: "ACCEPTED" }
                });
                await recordFixDecision(fix.findingId, fix.id, session.user.id, "FIX_ACCEPTED");
            }

            // Post a fix-validation report comment for the batch
            try {
                const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/dashboard/reviews/${reviewRunId}`;
                let fixMessage = `✅ **PRism successfully applied fixes** for ${fixes.length} issues in a single batch.\n\n`;
                if (result.resultPrUrl) {
                    fixMessage += `🔗 Fix Pull Request: ${result.resultPrUrl}\n`;
                } else if (result.resultCommitSha) {
                    fixMessage += `🔗 Fix Commit: ${result.resultCommitSha}\n`;
                }
                fixMessage += `\n**Validation checks passed in isolated environment:**\n` +
                              `- ✅ Code parsed cleanly\n` +
                              `- ✅ Findings were successfully resolved\n` +
                              `- ✅ No new issues introduced\n\n` +
                              `[View details in PRism Dashboard](${dashboardUrl})`;

                await octokit.rest.issues.createComment({
                    owner: reviewRun.repository.owner,
                    repo: reviewRun.repository.name,
                    issue_number: reviewRun.pullRequest.number,
                    body: fixMessage
                });
            } catch (e) {
                console.error("Failed to post batch fix comment to GitHub", e);
            }

            revalidatePath("/dashboard/reviews", "layout"); return { success: true };
        } else {
            await release();
            return { success: false, error: result.error || "Apply failed" };
        }
    } catch (e: any) {
        await release();
        return { success: false, error: e.message || "Apply exception" };
    }
}
