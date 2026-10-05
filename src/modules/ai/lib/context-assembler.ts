/**
 * Stage 5 RAG v2 - Context Assembler
 *
 * Assembles bounded multi-source context for a finding:
 * 1. Deterministic file window around finding
 * 2. PR diff hunk for that file (Stage 5: placeholder, populated by caller)
 * 3. Retrieved default-branch semantic chunks (RAG retrieval)
 * 4. Optional architecture card (not yet implemented)
 *
 * Does NOT feed into Gemini fix generation (Stage 6 concern).
 * Output is bounded to a configurable token budget.
 */


export interface DiffHunk {
    filePath: string;
    startLine: number;
    endLine: number;
    text: string;
}

export interface FindingWindow {
    filePath: string;
    startLine: number;
    endLine: number;
    text: string;
}

export interface AssembledContext {
    findingWindow: FindingWindow | null;
    diffHunks: string[];
    retrievedChunks: RetrievedChunk[];
    totalTokenEstimate: number;
}

export interface RetrievedChunk {
    path: string;
    startLine: number;
    endLine: number;
    text: string;
    score: number;
    chunkIndex: number;
    language: string;
}

// ---- Token budget ----
const MAX_TOKENS_TOTAL = 6000;
const TOKENS_PER_CHAR = 0.25; // ~4 chars per token (conservative)

function estimateTokens(text: string): number {
    return Math.ceil(text.length * TOKENS_PER_CHAR);
}

// ---- Same-file overlap deduplication ----

/**
 * Returns true if chunk overlaps the finding window (same file + line overlap).
 */
function overlapsWindow(chunk: RetrievedChunk, window: FindingWindow | null): boolean {
    if (!window) return false;
    if (chunk.path !== window.filePath) return false;
    return chunk.startLine <= window.endLine && chunk.endLine >= window.startLine;
}

/**
 * Deduplicate retrieved chunks:
 * - Remove chunks that overlap the deterministic finding window
 * - Remove duplicate paths (keep best score per path, one chunk)
 */
function deduplicateChunks(
    chunks: RetrievedChunk[],
    window: FindingWindow | null,
    maxChunks: number
): RetrievedChunk[] {
    const seen = new Set<string>();
    const result: RetrievedChunk[] = [];

    for (const chunk of chunks) {
        if (overlapsWindow(chunk, window)) continue;
        const key = `${chunk.path}#${chunk.chunkIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(chunk);
        if (result.length >= maxChunks) break;
    }

    return result;
}

/**
 * Assemble context for a finding from multiple sources.
 * Applies token budget and deduplication.
 *
 * @param findingWindow - deterministic file window around finding (may be null)
 * @param diffHunks - PR diff hunks (as text strings)
 * @param retrievedChunks - semantic retrieval results, sorted by score desc
 * @param maxRetrievedChunks - max chunks to include from retrieval (default 5)
 */
export function assembleContext(
    findingWindow: FindingWindow | null,
    diffHunks: string[],
    retrievedChunks: RetrievedChunk[],
    maxRetrievedChunks: number = 5
): AssembledContext {
    let remaining = MAX_TOKENS_TOTAL;

    // 1. Deterministic finding window (highest priority)
    let resolvedWindow = findingWindow;
    if (findingWindow) {
        const cost = estimateTokens(findingWindow.text);
        if (cost > remaining) {
            // Truncate if needed
            const maxChars = Math.floor(remaining / TOKENS_PER_CHAR);
            resolvedWindow = { ...findingWindow, text: findingWindow.text.slice(0, maxChars) };
        }
        remaining -= Math.min(cost, remaining);
    }

    // 2. Diff hunks
    const includedDiffHunks: string[] = [];
    for (const hunk of diffHunks) {
        const cost = estimateTokens(hunk);
        if (cost > remaining) break;
        includedDiffHunks.push(hunk);
        remaining -= cost;
    }

    // 3. Deduplicate retrieved chunks
    const deduped = deduplicateChunks(retrievedChunks, resolvedWindow, maxRetrievedChunks);

    // Apply token budget
    const includedChunks: RetrievedChunk[] = [];
    for (const chunk of deduped) {
        const cost = estimateTokens(chunk.text);
        if (cost > remaining) break;
        includedChunks.push(chunk);
        remaining -= cost;
    }

    const totalUsed = MAX_TOKENS_TOTAL - remaining;

    return {
        findingWindow: resolvedWindow,
        diffHunks: includedDiffHunks,
        retrievedChunks: includedChunks,
        totalTokenEstimate: totalUsed,
    };
}

/**
 * Serialise assembled context to a single string for LLM consumption.
 * Treats all repository content as untrusted data (wrapped in sections, not instructions).
 */
export function serialiseContext(ctx: AssembledContext, findingPath: string): string {
    const parts: string[] = [];

    if (ctx.findingWindow) {
        parts.push(`### Finding location (${findingPath}:${ctx.findingWindow.startLine}–${ctx.findingWindow.endLine})\n\`\`\`\n${ctx.findingWindow.text}\n\`\`\``);
    }

    if (ctx.diffHunks.length > 0) {
        parts.push(`### PR diff\n\`\`\`diff\n${ctx.diffHunks.join('\n')}\n\`\`\``);
    }

    for (const chunk of ctx.retrievedChunks) {
        parts.push(`### Related code (${chunk.path}:${chunk.startLine}–${chunk.endLine})\n\`\`\`${chunk.language}\n${chunk.text}\n\`\`\``);
    }

    return parts.join('\n\n');
}
