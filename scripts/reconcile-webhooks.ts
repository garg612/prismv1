import { config } from "dotenv";
config();
import { PrismaClient } from "../src/generated/prisma";
import { Octokit } from "octokit";

const prisma = new PrismaClient();

async function main() {
    console.log("Starting webhook reconciliation...");
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const webhookURL = `${process.env.NEXT_PUBLIC_APP_BASE_URL}/api/webhooks/github`;
    
    if (!secret) {
        console.error("GITHUB_WEBHOOK_SECRET is not set. Aborting.");
        process.exit(1);
    }
    
    const repositories = await prisma.repository.findMany({
        include: {
            user: {
                include: {
                    accounts: {
                        where: {
                            providerId: "github"
                        }
                    }
                }
            }
        }
    });

    console.log(`Found ${repositories.length} connected repositories.`);

    for (const repo of repositories) {
        try {
            const githubAccount = repo.user.accounts[0];
            if (!githubAccount || !githubAccount.accessToken) {
                console.warn(`Skipping ${repo.fullName}: No GitHub access token found for user.`);
                continue;
            }

            const octokit = new Octokit({ auth: githubAccount.accessToken });
            const [owner, repoName] = repo.fullName.split("/");

            const { data: hooks } = await octokit.rest.repos.listWebhooks({
                owner,
                repo: repoName,
            });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const existingHook = (hooks as any[]).find(h => h.config?.url === webhookURL);

            if (existingHook) {
                console.log(`Updating existing webhook for ${repo.fullName}...`);
                await octokit.rest.repos.updateWebhook({
                    owner,
                    repo: repoName,
                    hook_id: existingHook.id,
                    config: {
                        url: webhookURL,
                        content_type: "json",
                        secret: secret
                    }
                });
                console.log(`Successfully updated webhook for ${repo.fullName}.`);
            } else {
                console.log(`No existing PRism webhook found for ${repo.fullName}. Creating one...`);
                await octokit.rest.repos.createWebhook({
                    owner,
                    repo: repoName,
                    config: {
                        url: webhookURL,
                        content_type: "json",
                        secret: secret
                    },
                    events: ["push", "pull_request"],
                    active: true
                });
                console.log(`Successfully created webhook for ${repo.fullName}.`);
            }
        } catch (error) {
            console.error(`Failed to reconcile webhook for ${repo.fullName}:`, error);
        }
    }
    
    console.log("Webhook reconciliation complete.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
