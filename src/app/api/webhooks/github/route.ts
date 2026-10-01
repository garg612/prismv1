import { NextResponse, NextRequest } from "next/server";
import { inngest } from "@/inngest/client";
import { verifyGitHubWebhookSignature } from "@/modules/github/lib/webhook-verify";
import prisma from "@/lib/db";

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
                    id: deliveryId,
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
            const prNumber = body.number;

            if (!repo) {
                 return NextResponse.json({ message: "Invalid payload" }, { status: 400 });
            }

            const [owner, repoName] = repo.split("/");

            if (action === "opened" || action === "synchronize") {
                await inngest.send({
                    name: "pr.review.requested",
                    data: {
                        owner,
                        repo: repoName,
                        prNumber
                    }
                });
            }
        }

        return NextResponse.json({ message: "Event processed successfully" }, { status: 202 });
    } catch (err) {
        console.error("Error processing github webhook", err);
        return NextResponse.json({ message: "Error processing webhook", error: String(err) }, { status: 500 });
    }
}