/**
 * Stage 5 RAG v2 - Finding-aware query builder
 *
 * Builds a bounded, structured retrieval query from a finding's
 * structured data rather than raw PR prose.
 *
 * PR text is treated as untrusted data and never used as primary signal.
 */

import { Finding } from "@/generated/prisma/client";

export interface FindingQueryContext {
    ruleId: string;
    ruleMessage: string;
    filePath: string;
    startLine: number;
    endLine: number;
    severity: string;
    category: string;
    codeSnippet?: string;
    language?: string;
    symbol?: string;
    // CWE/OWASP from metadata
    cwe?: string;
    owasp?: string;
}

const MAX_SNIPPET_CHARS = 400;
const MAX_QUERY_CHARS = 1200;

/**
 * Build a structured finding-aware query string for semantic retrieval.
 * Does NOT include PR title/description as trusted instructions.
 */
export function buildFindingQuery(ctx: FindingQueryContext): string {
    const parts: string[] = [];

    // Core identifying information
    parts.push(`Rule: ${ctx.ruleId}`);
    parts.push(`File: ${ctx.filePath}`);
    if (ctx.language) parts.push(`Language: ${ctx.language}`);
    if (ctx.symbol) parts.push(`Symbol: ${ctx.symbol}`);
    parts.push(`Severity: ${ctx.severity} | Category: ${ctx.category}`);
    parts.push(`Lines: ${ctx.startLine}–${ctx.endLine}`);

    // Security metadata
    if (ctx.cwe) parts.push(`CWE: ${ctx.cwe}`);
    if (ctx.owasp) parts.push(`OWASP: ${ctx.owasp}`);

    // Rule message (finding context)
    parts.push(`Finding: ${ctx.ruleMessage}`);

    // Bounded code snippet
    if (ctx.codeSnippet) {
        const snippet = ctx.codeSnippet.slice(0, MAX_SNIPPET_CHARS);
        parts.push(`Code:\n${snippet}`);
    }

    const query = parts.join('\n');

    // Hard cap on total query size
    return query.slice(0, MAX_QUERY_CHARS);
}

/**
 * Extract FindingQueryContext from a Prisma Finding object.
 */
export function findingToQueryContext(finding: Finding): FindingQueryContext {
    const metadata = (finding.metadata as Record<string, unknown>) ?? {};
    const cwe = typeof metadata.cwe === 'string' ? metadata.cwe : undefined;
    const owasp = typeof metadata.owasp === 'string' ? metadata.owasp : undefined;
    const symbol = typeof metadata.symbol === 'string' ? metadata.symbol : undefined;
    const prismFeatures = metadata.prism_features as { symbol?: string } | undefined;
    const featureSymbol = prismFeatures?.symbol;

    return {
        ruleId: finding.ruleId,
        ruleMessage: finding.message,
        filePath: finding.filePath,
        startLine: finding.startLine,
        endLine: finding.endLine,
        severity: finding.severity,
        category: finding.category,
        codeSnippet: finding.codeSnippet ?? undefined,
        language: finding.language ?? undefined,
        symbol: symbol ?? featureSymbol ?? undefined,
        cwe,
        owasp,
    };
}
