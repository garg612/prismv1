/**
 * Stage 5 RAG v2 — Updated RAG module
 *
 * Replaces legacy one-vector-per-file with chunk-based, namespace-isolated retrieval.
 * Backward-compatible: legacy retrieveContext is preserved for the holistic review pipeline.
 */

import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/ai";
import { namespacedIndex, pineconeIndex, deleteVectorsByIds } from "@/lib/pinecone";
import { Chunk, makeVectorId, contentHash8 } from "./chunker";
import { RetrievedChunk } from "./context-assembler";

// ---- Constants ----
const EMBEDDING_BATCH_SIZE = 50;
const UPSERT_BATCH_SIZE = 100;
const MAX_METADATA_TEXT_CHARS = 4000; // Pinecone metadata value limit
const DEFAULT_TOP_K = 12;
const DEFAULT_FINAL_K = 5;
const RETRIEVAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---- Simple in-memory retrieval cache ----
interface CacheEntry {
    results: RetrievedChunk[];
    expiresAt: number;
}
const retrievalCache = new Map<string, CacheEntry>();

function getCacheKey(repositoryId: string, queryHash: string, indexedSha: string): string {
    return `${repositoryId}:${queryHash}:${indexedSha}`;
}

// ---- Embedding ----

export async function generateEmbedding(text: string): Promise<number[]> {
    const { embedding } = await embed({
        model: getEmbeddingModel(),
        value: text,
    });
    return embedding;
}

/**
 * Embed a batch of texts with bounded concurrency.
 * Returns embeddings in the same order as inputs.
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    const { embeddings } = await embedMany({
        model: getEmbeddingModel(),
        values: texts,
    });
    return embeddings;
}

// ---- Stage 5: chunk-based indexing ----

interface UpsertSummary {
    chunksUpserted: number;
    errors: string[];
}

/**
 * Upsert chunks into the repository's namespace.
 * Batches embedding and upsert operations.
 * Returns counts only (not raw vectors) for Inngest step safety.
 */
export async function upsertChunks(
    repositoryId: string,
    commitSha: string,
    chunks: Chunk[]
): Promise<UpsertSummary> {
    const errors: string[] = [];
    let chunksUpserted = 0;

    // Process in embedding batches
    for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
        const texts = batch.map(c => c.text);

        let embeddings: number[][];
        try {
            if (process.env.MOCK_EMBEDDINGS === '1') {
                embeddings = batch.map(() => Array.from({ length: 768 }, () => Math.random()));
            } else {
                embeddings = await generateEmbeddingsBatch(texts);
            }
        } catch (err) {
            errors.push(`Embedding batch ${i}–${i + batch.length}: ${String(err)}`);
            continue;
        }

        const vectors = batch.map((chunk, j) => {
            const id = makeVectorId(repositoryId, chunk.path, chunk.chunkIndex, chunk.contentHash);
            // Metadata: bounded text, no secrets
            const metadataText = chunk.text.slice(0, MAX_METADATA_TEXT_CHARS);
            return {
                id,
                values: embeddings[j],
                metadata: {
                    path: chunk.path,
                    language: chunk.language,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    chunkIndex: chunk.chunkIndex,
                    commitSha,
                    contentHash: chunk.contentHash,
                    symbol: chunk.symbol ?? '',
                    kind: chunk.kind ?? '',
                    text: metadataText,
                },
            };
        });

        // Upsert in sub-batches
        const ns = namespacedIndex(repositoryId);
        for (let j = 0; j < vectors.length; j += UPSERT_BATCH_SIZE) {
            try {
                await ns.upsert({ records: vectors.slice(j, j + UPSERT_BATCH_SIZE) });
                chunksUpserted += Math.min(UPSERT_BATCH_SIZE, vectors.length - j);
            } catch (err) {
                errors.push(`Upsert batch error: ${String(err)}`);
            }
        }
    }

    return { chunksUpserted, errors };
}

/**
 * Delete stale chunk vectors for a file when it's updated or removed.
 * Uses deterministic IDs from old chunks.
 */
export async function deleteFileChunks(
    repositoryId: string,
    filePath: string
): Promise<void> {
    const ns = namespacedIndex(repositoryId);
    try {
        await ns.deleteMany({ filter: { path: filePath } });
    } catch (err: any) {
        if (err?.name !== 'PineconeNotFoundError' && !err?.message?.includes('404')) {
            throw err;
        }
    }
}

// ---- Stage 5: finding-aware retrieval ----

/**
 * Retrieve semantically similar chunks for a finding query.
 * Uses repository namespace for tenant isolation.
 * Applies retrieval cache keyed on (repositoryId, queryHash, indexedSha).
 */
export async function retrieveChunksForFinding(
    repositoryId: string,
    query: string,
    indexedSha: string,
    opts: { topK?: number; finalK?: number } = {}
): Promise<RetrievedChunk[]> {
    const { topK = DEFAULT_TOP_K, finalK = DEFAULT_FINAL_K } = opts;

    // Cache key
    const qHash = contentHash8(query);
    const cacheKey = getCacheKey(repositoryId, qHash, indexedSha);
    const cached = retrievalCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.results.slice(0, finalK);
    }

    const queryEmbedding = await generateEmbedding(query);
    const ns = namespacedIndex(repositoryId);

    const result = await ns.query({
        vector: queryEmbedding,
        topK,
        includeMetadata: true,
    });

    const chunks: RetrievedChunk[] = (result.matches ?? [])
        .filter(m => m.metadata && m.score !== undefined && m.score > 0.1)
        .map(m => ({
            path: String(m.metadata!.path ?? ''),
            startLine: Number(m.metadata!.startLine ?? 0),
            endLine: Number(m.metadata!.endLine ?? 0),
            text: String(m.metadata!.text ?? ''),
            score: m.score ?? 0,
            chunkIndex: Number(m.metadata!.chunkIndex ?? 0),
            language: String(m.metadata!.language ?? 'text'),
        }));

    // Store in cache
    retrievalCache.set(cacheKey, { results: chunks, expiresAt: Date.now() + RETRIEVAL_CACHE_TTL_MS });

    // Evict old entries (simple size cap)
    if (retrievalCache.size > 500) {
        const oldest = [...retrievalCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        for (const [k] of oldest.slice(0, 100)) retrievalCache.delete(k);
    }

    return chunks.slice(0, finalK);
}

// ---- Legacy retrieval (backward compatibility for holistic review, Stage 0-4) ----

/**
 * Legacy context retrieval using global repoId filter.
 * Preserved for holistic review pipeline (Stage 0-1).
 * New finding-aware retrieval uses retrieveChunksForFinding.
 */
export async function retrieveContext(
    query: string,
    repoId: string,
    topK: number = 5
): Promise<string[]> {
    const embedding = await generateEmbedding(query);

    // Try namespaced first (Stage 5 index), fall back to legacy filter
    try {
        const ns = namespacedIndex(repoId);
        const results = await ns.query({
            vector: embedding,
            topK,
            includeMetadata: true,
        });
        const texts = results.matches.map(m => m.metadata?.text as string).filter(Boolean);
        if (texts.length > 0) return texts;
    } catch {
        // namespace may not exist yet, fall through to legacy
    }

    // Legacy fallback: global filter by repoId
    const results = await pineconeIndex.query({
        vector: embedding,
        filter: { repoId },
        topK,
        includeMetadata: true,
    });
    return results.matches.map(m => m.metadata?.content as string).filter(Boolean);
}

// ---- Legacy indexing (preserved for backward compat) ----

/**
 * @deprecated Use upsertChunks from Stage 5 pipeline instead.
 * Preserved so existing test references compile.
 */
export async function indexCodebase(
    repoId: string,
    files: { path: string; content: string }[]
): Promise<void> {
    const vectors = [];
    for (const file of files) {
        const content = `File:${file.path}\n\n${file.content}`;
        const truncatedContent = content.slice(0, 8000);
        try {
            const embedding = await generateEmbedding(truncatedContent);
            vectors.push({
                id: `${repoId}-${file.path.replace(/\//g, '_')}`,
                values: embedding,
                metadata: { repoId, path: file.path, content: truncatedContent },
            });
        } catch (err) {
            console.error(`Failed to embed file ${file.path}:`, err);
            throw err;
        }
    }
    if (vectors.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < vectors.length; i += batchSize) {
             
            await (pineconeIndex as any).upsert(vectors.slice(i, i + batchSize));
        }
    }
}