/**
 * Stage 5 RAG v2 — Incremental reindex Inngest function
 *
 * Handles both full initial indexing (repository.connected) and
 * incremental reindexing on default-branch push (repository.pushed).
 *
 * Inngest step outputs: counts only (never full file content / vectors).
 * Index state machine: INDEXING → READY | FAILED
 */

import { inngest } from "../client";
import prisma from "@/lib/db";
import {
    getDefaultBranchSha,
    getRepoTree,
    getBlob,
    getChangedFiles,
} from "@/modules/github/lib/github";
import { isPathAllowed, isContentAllowed } from "@/modules/ai/lib/indexing-policy";
import { chunkFile } from "@/modules/ai/lib/chunker";
import { upsertChunks, deleteFileChunks } from "@/modules/ai/lib/rag";
import { deleteRepositoryNamespace, deleteLegacyRepositoryVectors, verifyIndexDimension } from "@/lib/pinecone";
import { NonRetriableError } from "inngest";

const BLOB_BATCH_SIZE = 20;     // How many blobs to fetch/embed per batch
const MAX_FILES_PER_RUN = 2000; // Safety cap

// ---- Helper: get account token ----
async function getToken(userId: string): Promise<string> {
    const account = await prisma.account.findFirst({
        where: { userId, providerId: "github" },
    });
    if (!account?.accessToken) throw new NonRetriableError("GitHub token unavailable");
    return account.accessToken;
}

// ---- Full initial indexing ----

export const indexRepoV2 = inngest.createFunction(
    {
        id: "index-repo-v2",
        concurrency: { limit: 3 },
        triggers: { event: "repository.connected" },
    },
    async ({ event, step }) => {
        const { owner, repo, userId, repositoryId } = event.data;

        // 1. Mark repository as INDEXING
        await step.run("mark-indexing", async () => {
            await prisma.repository.update({
                where: { id: repositoryId },
                data: { indexState: "INDEXING", indexedSha: null },
            });
            return { state: "INDEXING" };
        });

        // 2. Resolve default branch SHA — pin before any work
        const { commitSha, branch } = await step.run("resolve-sha", async () => {
            const token = await getToken(userId);
            const { sha, branch } = await getDefaultBranchSha(token, owner, repo);
            return { commitSha: sha, branch };
        });

        // 3. Enumerate tree (flat blob list)
        const { eligiblePaths, skippedCount } = await step.run("enumerate-tree", async () => {
            const token = await getToken(userId);
            const tree = await getRepoTree(token, owner, repo, commitSha);
            const eligible: Array<{ path: string; sha: string; size: number }> = [];
            let skipped = 0;

            for (const entry of tree.slice(0, MAX_FILES_PER_RUN)) {
                const pathCheck = isPathAllowed(entry.path);
                if (!pathCheck.allowed) { skipped++; continue; }
                const sizeCheck = isContentAllowed(entry.size);
                if (!sizeCheck.allowed) { skipped++; continue; }
                eligible.push({ path: entry.path, sha: entry.sha, size: entry.size });
            }
            return { eligiblePaths: eligible, skippedCount: skipped };
        });

        // Wrap indexing in try/catch for failure safety
        try {
            await step.run("verify-dimension", async () => {
                await verifyIndexDimension();
                return { ok: true };
            });

            // 4. Clear old namespace and legacy vectors before full reindex
            await step.run("clear-namespace", async () => {
                await deleteRepositoryNamespace(repositoryId);
                await deleteLegacyRepositoryVectors(`${owner}/${repo}`);
                return { cleared: true };
            });

            // 5. Index in batches — each step returns counts, never content
            let totalChunks = 0;
            let totalVectors = 0;
            const batchCount = Math.ceil(eligiblePaths.length / BLOB_BATCH_SIZE);

            for (let i = 0; i < batchCount; i++) {
                const batch = eligiblePaths.slice(i * BLOB_BATCH_SIZE, (i + 1) * BLOB_BATCH_SIZE);

                const result = await step.run(`index-batch-${i}`, async () => {
                    const token = await getToken(userId);
                    let chunksCreated = 0;
                    let vectorsUpserted = 0;
                    const errors: string[] = [];

                    for (const entry of batch) {
                        const content = await getBlob(token, owner, repo, entry.sha);
                        if (content === null) continue;

                        const chunks = chunkFile(repositoryId, entry.path, commitSha, content);
                        if (chunks.length === 0) continue;

                        const summary = await upsertChunks(repositoryId, commitSha, chunks);
                        chunksCreated += chunks.length;
                        vectorsUpserted += summary.chunksUpserted;
                        errors.push(...summary.errors);
                    }

                    return { chunksCreated, vectorsUpserted, errors };
                });

                totalChunks += result.chunksCreated;
                totalVectors += result.vectorsUpserted;
            }

            // 6. Mark READY only after successful completion
            await step.run("mark-ready", async () => {
                await prisma.repository.update({
                    where: { id: repositoryId },
                    data: {
                        indexState: "READY",
                        indexedSha: commitSha,
                        defaultBranch: branch,
                    },
                });
                return { state: "READY" };
            });

            return {
                success: true,
                commitSha,
                branch,
                eligibleFiles: eligiblePaths.length,
                skippedFiles: skippedCount,
                chunksCreated: totalChunks,
                vectorsUpserted: totalVectors,
            };
        } catch (err) {
            // On failure: mark FAILED, leave indexedSha as null (or previous if incremental)
            // Note: Since we cleared the namespace at step 4, the index is empty,
            // so we cannot claim READY until a full successful rebuild.
            await prisma.repository.update({
                where: { id: repositoryId },
                data: { indexState: "FAILED" },
            });
            throw err;
        }
    }
);

// ---- Incremental reindex on push ----

export const reindexIncremental = inngest.createFunction(
    {
        id: "reindex-incremental",
        concurrency: { limit: 3 },
        triggers: { event: "repository.pushed" },
    },
    async ({ event, step }) => {
        const { repositoryId, newSha, previousSha, owner, repo, userId } = event.data;

        // Guard: same SHA already indexed — skip
        const repository = await step.run("check-sha", async () => {
            return await prisma.repository.findUnique({ where: { id: repositoryId } });
        });

        if (!repository) throw new NonRetriableError("Repository not found");
        if (repository.indexedSha === newSha) {
            return { skipped: true, reason: "already_indexed" };
        }

        // 1. Mark INDEXING (preserve previous sha until complete)
        const previousIndexedSha = repository.indexedSha;
        await step.run("mark-indexing", async () => {
            await prisma.repository.update({
                where: { id: repositoryId },
                data: { indexState: "INDEXING" },
            });
            return { state: "INDEXING" };
        });

        try {
            await step.run("verify-dimension", async () => {
                await verifyIndexDimension();
                return { ok: true };
            });

            // 2. Get changed files between previousSha and newSha
            const { added, modified, removed } = await step.run("diff-files", async () => {
                const token = await getToken(userId);
                if (!previousSha) {
                    // No previous sha: this is effectively a full reindex trigger
                    return { added: [], modified: [], removed: [] };
                }
                return await getChangedFiles(token, owner, repo, previousSha, newSha);
            });

            const toIndex = [...added, ...modified];

            // 3. Delete vectors for removed and modified files (stale cleanup)
            await step.run("delete-stale", async () => {
                const pathsToClean = [...removed, ...modified];
                for (const filePath of pathsToClean) {
                    await deleteFileChunks(repositoryId, filePath);
                }
                return { pathsCleaned: pathsToClean.length, note: "stale_ids_deleted_by_path_filter" };
            });

            // 4. Index changed files in batches
            let totalChunks = 0;
            let totalVectors = 0;

            if (toIndex.length > 0) {
                const batchCount = Math.ceil(toIndex.length / BLOB_BATCH_SIZE);
                for (let i = 0; i < batchCount; i++) {
                    const batch = toIndex.slice(i * BLOB_BATCH_SIZE, (i + 1) * BLOB_BATCH_SIZE);
                    const result = await step.run(`incremental-batch-${i}`, async () => {
                        const token = await getToken(userId);
                        let chunksCreated = 0;
                        let vectorsUpserted = 0;

                        for (const filePath of batch) {
                            const pathCheck = isPathAllowed(filePath);
                            if (!pathCheck.allowed) continue;

                            // Get current blob SHA from new tree
                            const tree = await getRepoTree(token, owner, repo, newSha);
                            const entry = tree.find(e => e.path === filePath);
                            if (!entry) continue;

                            const sizeCheck = isContentAllowed(entry.size);
                            if (!sizeCheck.allowed) continue;

                            const content = await getBlob(token, owner, repo, entry.sha);
                            if (content === null) continue;

                            const chunks = chunkFile(repositoryId, filePath, newSha, content);
                            const summary = await upsertChunks(repositoryId, newSha, chunks);
                            chunksCreated += chunks.length;
                            vectorsUpserted += summary.chunksUpserted;
                        }

                        return { chunksCreated, vectorsUpserted };
                    });
                    totalChunks += result.chunksCreated;
                    totalVectors += result.vectorsUpserted;
                }
            }

            // 5. Mark READY with new SHA only after success
            await step.run("mark-ready", async () => {
                await prisma.repository.update({
                    where: { id: repositoryId },
                    data: { indexState: "READY", indexedSha: newSha },
                });
                return { state: "READY" };
            });

            return {
                success: true,
                previousSha,
                newSha,
                added: added.length,
                modified: modified.length,
                removed: removed.length,
                chunksCreated: totalChunks,
                vectorsUpserted: totalVectors,
            };
        } catch (err) {
            // On failure: preserve previous indexedSha, mark FAILED
            await prisma.repository.update({
                where: { id: repositoryId },
                data: {
                    indexState: "FAILED",
                    indexedSha: previousIndexedSha, // preserve last good SHA
                },
            });
            throw err;
        }
    }
);


