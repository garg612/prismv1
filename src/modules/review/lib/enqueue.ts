import { inngest } from "@/inngest/client";

export interface EnqueueReviewArgs {
    repositoryGithubId: number;
    prNumber: number;
    headSha: string;
    action: string;
    deliveryId: string;
    owner: string;
    repo: string;
    userId?: string;
}

export async function enqueueReviewRequested(args: EnqueueReviewArgs) {
    await inngest.send({
        name: "pr.review.requested",
        data: {
            repositoryGithubId: args.repositoryGithubId,
            prNumber: args.prNumber,
            headSha: args.headSha,
            action: args.action,
            deliveryId: args.deliveryId,
            owner: args.owner,
            repo: args.repo,
            userId: args.userId
        }
    });
}
