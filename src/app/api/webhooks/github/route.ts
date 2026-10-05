import { NextResponse, NextRequest } from "next/server";
import { verifyGitHubWebhookSignature } from "@/modules/github/lib/webhook-verify";
import prisma from "@/lib/db";
import { inngest } from "@/inngest/client";
import { enqueueReviewRequested } from "@/modules/review/lib/enqueue";

export async function POST(request: NextRequest) {
    try {
        const rawBody = await request.text();
        const signature = request.headers.get("x-hub-signature-256");
        const secret = process.env.GITHUB_WEBHOOK_SECRET;

        if (!verifyGitHubWebhookSignature(rawBody, signature, secret)) {
            return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
        }

        const deliveryId = request.headers.get("x-github-delivery");
        const event = request.headers.get("x-github-event");

        if (!deliveryId) {
            return NextResponse.json({ message: "Missing delivery ID" }, { status: 400 });
        }

        // Deduplication
        try {
            await prisma.webhookEvent.create({
                data: {
                    deliveryId,
                    event: event || "unknown"
                }
            });
        } catch {
            // Unique constraint violation means it's a duplicate delivery
            return NextResponse.json({ message: "Duplicate delivery" }, { status: 202 });
        }

        if (event === "ping") {
            return NextResponse.json({ message: "Pong" }, { status: 202 });
        }

        const body = JSON.parse(rawBody);

        if (event === "pull_request") {
            const action = body.action;
            const repo = body.repository?.full_name;
            const repositoryGithubId = body.repository?.id;
            const prNumber = body.number;
            const headSha = body.pull_request?.head?.sha;

            if (!repo || !repositoryGithubId || !headSha) {
                 return NextResponse.json({ message: "Invalid payload" }, { status: 400 });
            }

            const [owner, repoName] = repo.split("/");

            if (action === "opened" || action === "synchronize") {
                if (body.pull_request?.head?.ref?.startsWith("prism/fix/")) {
                    return NextResponse.json({ message: "Ignored PRism fix branch" }, { status: 202 });
                }

                let finalAction = action;
                if (action === "synchronize") {
                    const applyAttempt = await prisma.applyAttempt.findFirst({
                        where: { resultCommitSha: headSha, status: "SUCCEEDED" }
                    });
                    if (applyAttempt) {
                        finalAction = "POST_APPLY_VERIFY";
                    }
                }

                await enqueueReviewRequested({
                    repositoryGithubId,
                    prNumber,
                    headSha,
                    action: finalAction,
                    deliveryId,
                    owner,
                    repo: repoName
                });
            }
        }

        // Stage 5: handle default-branch push for incremental reindexing
        if (event === "push") {
            const pushRef = body.ref as string | undefined;
            const repositoryGithubId = body.repository?.id;
            const newSha = body.after as string | undefined;
            const previousSha = body.before as string | undefined;

            if (pushRef && repositoryGithubId && newSha && newSha !== '0000000000000000000000000000000000000000') {
                // Find connected repository
                const repository = await prisma.repository.findFirst({
                    where: { githubId: BigInt(repositoryGithubId) },
                    include: { user: { include: { accounts: { where: { providerId: "github" } } } } },
                });

                if (repository) {
                    const defaultBranch = repository.defaultBranch ?? 'main';
                    const branchName = pushRef.replace('refs/heads/', '');

                    // Only reindex pushes to the default branch
                    if (branchName === defaultBranch) {
                        const [owner, repo] = repository.fullName.split('/');
                        const userId = repository.userId;

                        // Prevent duplicate indexing for same SHA
                        if (repository.indexedSha !== newSha) {
                            await inngest.send({
                                name: "repository.pushed",
                                data: {
                                    repositoryId: repository.id,
                                    owner,
                                    repo,
                                    userId,
                                    newSha,
                                    previousSha: previousSha || repository.indexedSha || null,
                                    branch: branchName,
                                },
                            });
                        }
                    }
                }
            }
        }

        return NextResponse.json({ message: "Event processed successfully" }, { status: 202 });
    } catch (err) {
        console.error("Error processing github webhook", err);
        return NextResponse.json({ message: "Error processing webhook", error: String(err) }, { status: 500 });
    }
}