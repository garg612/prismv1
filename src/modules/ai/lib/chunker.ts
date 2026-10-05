import * as crypto from 'crypto';

/**
 * Stage 5 RAG v2 Chunker
 *
 * Target: 40-120 lines per chunk, ~300-800 tokens, ~10-line overlap.
 * Uses deterministic blank-line/indentation heuristics.
 * Every chunk has stable metadata for ID generation.
 */

export interface Chunk {
    repositoryId: string;
    path: string;
    commitSha: string;
    startLine: number;   // 1-indexed inclusive
    endLine: number;     // 1-indexed inclusive
    chunkIndex: number;
    contentHash: string; // sha256 hex (first 16 chars)
    language: string;
    text: string;
    symbol?: string;
    kind?: string;
}

// ---- Language detection ----

const EXT_TO_LANG: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', java: 'java', rb: 'ruby', rs: 'rust',
    cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
    sh: 'bash', yaml: 'yaml', yml: 'yaml', json: 'json',
    md: 'markdown', txt: 'text', sql: 'sql', graphql: 'graphql',
    html: 'html', css: 'css', scss: 'css', less: 'css',
    env: 'env', toml: 'toml', xml: 'xml',
};

export function detectLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return EXT_TO_LANG[ext] ?? 'text';
}

// ---- Content hash ----

export function contentHash8(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ---- Stable vector ID ----
// Format: ${repositoryId}#${path}#${chunkIndex}#${contentHash8}
// This ensures:
//  - Repository isolation (different repo → different prefix)
//  - Path collision safety (# separates fields, path uses forward slashes only)
//  - Content-addressed (same content+location → same ID, content change → new ID)

export function makeVectorId(repositoryId: string, path: string, chunkIndex: number, hash8: string): string {
    // Normalise path: forward slashes, trim leading slash
    const normPath = path.replace(/\\/g, '/').replace(/^\//, '');
    return `${repositoryId}#${normPath}#${chunkIndex}#${hash8}`;
}

// ---- Chunking ----

const MIN_LINES = 40;
const MAX_LINES = 120;
const TARGET_LINES = 80;
const OVERLAP_LINES = 10;

/**
 * Split lines into chunks respecting MIN/MAX constraints.
 * Strategy:
 *  1. Try to break at blank lines near the target size.
 *  2. Fall back to hard breaks at MAX_LINES.
 *  3. Apply OVERLAP_LINES overlap across boundaries.
 */
function splitIntoLineRanges(lines: string[]): Array<{ start: number; end: number }> {
    const total = lines.length;
    if (total === 0) return [];

    // For short files just one chunk
    if (total <= MAX_LINES) {
        return [{ start: 0, end: total - 1 }];
    }

    const ranges: Array<{ start: number; end: number }> = [];
    let pos = 0;

    while (pos < total) {
        const remaining = total - pos;
        if (remaining <= MAX_LINES) {
            // Last chunk: include overlap from previous
            const start = Math.max(0, pos - OVERLAP_LINES);
            ranges.push({ start, end: total - 1 });
            break;
        }

        // Try to find a good break point (blank line) near TARGET_LINES
        let breakAt = pos + TARGET_LINES;
        let found = false;

        // Search forward from target to MAX for a blank line
        for (let i = breakAt; i <= Math.min(pos + MAX_LINES, total - 1); i++) {
            if (lines[i].trim() === '') {
                breakAt = i;
                found = true;
                break;
            }
        }

        // If not found, search backward from target to MIN
        if (!found) {
            for (let i = breakAt; i >= pos + MIN_LINES; i--) {
                if (lines[i].trim() === '') {
                    breakAt = i;
                    found = true;
                    break;
                }
            }
        }

        // Hard break
        if (!found) {
            breakAt = pos + TARGET_LINES;
        }

        const chunkStart = ranges.length === 0 ? 0 : Math.max(0, pos - OVERLAP_LINES);
        ranges.push({ start: chunkStart, end: Math.min(breakAt, total - 1) });
        pos = breakAt + 1;
    }

    return ranges;
}

/**
 * Chunk a file into overlapping text segments.
 * Returns an array of Chunk objects.
 */
export function chunkFile(
    repositoryId: string,
    path: string,
    commitSha: string,
    content: string
): Chunk[] {
    if (!content || content.trim() === '') return [];

    const language = detectLanguage(path);
    const allLines = content.split('\n');
    const ranges = splitIntoLineRanges(allLines);

    const chunks: Chunk[] = [];

    for (let i = 0; i < ranges.length; i++) {
        const { start, end } = ranges[i];
        const text = allLines.slice(start, end + 1).join('\n');
        const hash = contentHash8(text);

        // Try to detect the first symbol (function/class/method) in chunk
        const symbol = detectFirstSymbol(allLines, start, end, language);

        chunks.push({
            repositoryId,
            path,
            commitSha,
            startLine: start + 1,   // 1-indexed
            endLine: end + 1,       // 1-indexed
            chunkIndex: i,
            contentHash: hash,
            language,
            text,
            symbol: symbol?.name,
            kind: symbol?.kind,
        });
    }

    return chunks;
}

// ---- Symbol detection (lightweight heuristics) ----

interface SymbolInfo { name: string; kind: string; }

const SYMBOL_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
    { pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: 'function' },
    { pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/, kind: 'function' },
    { pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function)/, kind: 'function' },
    { pattern: /^\s*(?:async\s+)?(\w+)\s*\(.*\)\s*\{/, kind: 'method' },
    { pattern: /^\s*def\s+(\w+)/, kind: 'function' },    // Python
    { pattern: /^\s*func\s+(\w+)/, kind: 'function' },   // Go/Swift
    { pattern: /^\s*(?:pub\s+)?fn\s+(\w+)/, kind: 'function' }, // Rust
];

function detectFirstSymbol(
    lines: string[],
    start: number,
    end: number,
    language: string
): SymbolInfo | undefined {
    if (['yaml', 'json', 'text', 'markdown', 'env'].includes(language)) return undefined;

    for (let i = start; i <= end; i++) {
        const line = lines[i];
        for (const { pattern, kind } of SYMBOL_PATTERNS) {
            const m = line.match(pattern);
            if (m && m[1]) {
                return { name: m[1], kind };
            }
        }
    }
    return undefined;
}
