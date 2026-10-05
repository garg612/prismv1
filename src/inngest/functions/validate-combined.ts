import { inngest } from "../client";
import prisma from "@/lib/db";
import { getTarballUrl } from "@/modules/github/lib/github";
import { buildCombinedPatch } from "@/modules/fix/lib/overlap";
import { getFileCommitsSince } from "@/modules/github/lib/github";
import { generateDeterministicPatch } from "@/modules/fix/lib/diff";
import { requestValidation } from "@/modules/runner/lib/client";
import { getEnabledScanners } from "@/modules/scanners/registry";

export const validateCombined = inngest.createFunction(
    { id: "validate-combined", triggers: [{ event: "review.combined_validation.requested" }] },
    async ({ event, step }: { event: any, step: any }) => {
        const { reviewRunId, fixIds } = event.data;

        const data = await step.run("fetch-fixes", async () => {
            const reviewRun = await prisma.reviewRun.findUnique({
                where: { id: reviewRunId },
                include: { 
                    repository: { include: { user: { include: { accounts: { where: { providerId: "github" } } } } } },
                    pullRequest: true
                }
            });

            if (!reviewRun) throw new Error("ReviewRun not found");

            const fixes = await prisma.suggestedFix.findMany({
                where: { id: { in: fixIds }, reviewRunId, status: "READY" }
            });

            return { reviewRun, fixes };
        });

        if (data.fixes.length === 0) {
            return { success: true, skipped: true, reason: "No READY fixes provided" };
        }

        const account = data.reviewRun.repository.user.accounts[0];
        if (!account?.accessToken) throw new Error("GitHub token unavailable");

        // Download base contents to determine overlap and generate combined patch
        const owner = data.reviewRun.pullRequest.headRepoFullName.split('/')[0];
        const repo = data.reviewRun.pullRequest.headRepoFullName.split('/')[1] || data.reviewRun.pullRequest.headRepoFullName;
        const headRef = data.reviewRun.pullRequest.latestHeadSha;

        const baseContents = await step.run("fetch-base-contents", async () => {
            const contents: Record<string, string> = {};
            const files = Array.from(new Set(data.fixes.flatMap((f: any) => (f.edits as any[]).map(e => e.path as string))));
            for (const file of files as string[]) {
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${headRef}`, {
                    headers: {
                        Authorization: `Bearer ${account.accessToken}`,
                        Accept: "application/vnd.github.v3.raw"
                    }
                });
                if (res.ok) {
                    contents[file] = await res.text();
                } else {
                    throw new Error(`Failed to fetch ${file}`);
                }
            }
            return contents;
        });

        const patchStats = await step.run("build-combined-patch", async () => {
            const combinedProposal = buildCombinedPatch(data.fixes, baseContents);
            const patch = generateDeterministicPatch(combinedProposal as any, baseContents);
            return { patch, includedFixIds: combinedProposal.includedFixIds };
        });

        const validationRun = await step.run("create-validation-run", async () => {
            return await prisma.validationRun.create({
                data: {
                    reviewRunId,
                    kind: "COMBINED",
                    tier: "STATIC", // We can promote to execution if enabled
                    status: "PENDING",
                    headSha: headRef,
                    includedFixIds: patchStats.includedFixIds
                }
            });
        });

        // Trigger runner
        await step.run("dispatch-validation", async () => {
            const tarballUrl = await getTarballUrl(account.accessToken, owner, repo, headRef);
            // Combined validation re-scans with a single scanner; per-fix validation covers each finding's own scanner.
            await requestValidation(validationRun.id, tarballUrl, patchStats.patch.unifiedDiff, getEnabledScanners()[0].id);
            await prisma.validationRun.update({
                where: { id: validationRun.id },
                data: { status: "RUNNING", startedAt: new Date() }
            });
        });

        // Wait for completion
        const validationEvent = await step.waitForEvent("wait-for-validation", {
            event: "runner.validate.completed",
            if: `async.data.validationRunId == '${validationRun.id}'`,
            timeout: "5m"
        });

        if (!validationEvent) {
            await step.run("mark-timeout", async () => {
                await prisma.validationRun.update({
                    where: { id: validationRun.id },
                    data: { status: "TIMEOUT", finishedAt: new Date() }
                });
            });
            throw new Error("Validation timed out");
        }

        return { success: true, validationRunId: validationRun.id };
    }
);
