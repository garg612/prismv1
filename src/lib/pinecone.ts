/**
 * Stage 5 RAG v2 — Updated Pinecone client
 *
 * Changes from legacy:
 * - Index name driven by PINECONE_INDEX_NAME env var (not hardcoded 'prism-v2')
 * - Exposes namespace helper per repository
 * - Exports dimension/model verification utilities
 */

import { Pinecone } from "@pinecone-database/pinecone";

export const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
});

/** Configuration-driven index name. Defaults to 'prism-v2' for backward compatibility. */
if (!process.env.PINECONE_INDEX_NAME) {
    throw new Error("Missing required environment variable: PINECONE_INDEX_NAME");
}
export const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

export const pineconeIndex = pinecone.Index(PINECONE_INDEX_NAME);

/**
 * Per-repository namespace for tenant isolation.
 * Format: repo:<repositoryId>
 *
 * This ensures:
 * - Queries for repo A cannot retrieve repo B's vectors
 * - Disconnect deletes exactly one namespace
 * - No global namespace for repository source vectors
 */
export function repoNamespace(repositoryId: string): string {
    return `repo:${repositoryId}`;
}

/**
 * Get a namespace-scoped index for a specific repository.
 */
export function namespacedIndex(repositoryId: string) {
    return pineconeIndex.namespace(repoNamespace(repositoryId));
}

/**
 * Delete all vectors for a repository namespace (disconnect cleanup).
 * Uses deleteAll on the namespace — affects only that repository's vectors.
 */
export async function deleteRepositoryNamespace(repositoryId: string): Promise<void> {
    const ns = namespacedIndex(repositoryId);
    try {
        await ns.deleteAll();
    } catch (err: any) {
        if (err.name === 'PineconeNotFoundError' || (err.status && err.status === 404) || err.message?.includes('404')) {
            console.log(`Namespace ${repoNamespace(repositoryId)} not found or already empty.`);
        } else {
            console.error(`Error clearing namespace ${repoNamespace(repositoryId)}:`, err);
            throw err;
        }
    }
}

/**
 * Delete vectors by their exact IDs within a repository namespace.
 */
export async function deleteVectorsByIds(repositoryId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const ns = namespacedIndex(repositoryId);

    // Pinecone supports up to 1000 IDs per delete call
    const BATCH = 1000;
    for (let i = 0; i < ids.length; i += BATCH) {
        await ns.deleteMany(ids.slice(i, i + BATCH));
    }
}

// Legacy export for backward compatibility (used by Stage 0-4 holistic review)
export { pineconeIndex as legacyPineconeIndex };

/**
 * Delete legacy global-namespace vectors for a specific repository.
 * This is used for migration cleanup once the Stage 5 namespace is populated.
 */
export async function deleteLegacyRepositoryVectors(repoFullName: string): Promise<void> {
    try {
        await pineconeIndex.deleteMany({ filter: { repoId: repoFullName } });
    } catch (e) {
        console.error(`Failed to delete legacy vectors for ${repoFullName}:`, e);
    }
}

/**
 * Verify that the configured Pinecone index matches the required embedding dimension.
 * Must be called before Stage 5 writes any vectors. Throws if mismatched.
 */
export async function verifyIndexDimension(): Promise<void> {
    const stats = await pineconeIndex.describeIndexStats();
    if (!stats.dimension) {
        throw new Error(`Pinecone index ${PINECONE_INDEX_NAME} returned no dimension stats.`);
    }
    // gemini-embedding-2 uses 3072 dimensions
    if (stats.dimension !== 3072) {
        throw new Error(
            `Dimension mismatch: Pinecone index '${PINECONE_INDEX_NAME}' has dimension ${stats.dimension}, ` +
            `but the Stage 5 embedding model requires 3072 dimensions. Indexing aborted.`
        );
    }
}