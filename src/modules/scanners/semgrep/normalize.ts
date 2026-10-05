import { SemgrepFinding } from './schema';
import { generateFingerprint } from './fingerprint';
import { toRepoRelativePath } from './path';
import { FindingCategory, Severity } from '@/generated/prisma/client';
import type { NormalizedFinding } from '@/modules/scanners/types';

export type { NormalizedFinding };

export function normalizeSemgrepSeverity(semgrepSev: string): Severity {
    const sev = semgrepSev.toUpperCase();
    // Already a normalized value (or Semgrep's newer severity vocabulary)
    if (sev === 'CRITICAL' || sev === 'HIGH' || sev === 'MEDIUM' || sev === 'LOW') return sev;
    if (sev === 'ERROR') return 'HIGH';
    if (sev === 'WARNING') return 'MEDIUM';
    if (sev === 'INFO') return 'INFO';
    return 'LOW';
}

export function normalizeSemgrepCategory(metadataCategory?: string): FindingCategory {
    if (!metadataCategory) return 'OTHER';
    const cat = metadataCategory.toUpperCase();
    if (cat === 'SECURITY') return 'SECURITY';
    if (cat === 'PERFORMANCE') return 'PERFORMANCE';
    if (cat === 'MAINTAINABILITY') return 'MAINTAINABILITY';
    if (cat === 'CORRECTNESS') return 'CORRECTNESS';
    if (cat === 'BEST_PRACTICE') return 'BEST_PRACTICE';
    if (cat === 'STYLE') return 'STYLE';
    return 'OTHER';
}

export function normalizeFinding(raw: SemgrepFinding): NormalizedFinding {
    // The runner emits repository-relative paths; anything else is rejected, not rewritten.
    const filePath = toRepoRelativePath(raw.path);

    const snippet = raw.extra.lines || '';
    const fingerprint = generateFingerprint(raw.check_id, filePath, snippet);

    const metadata: Record<string, unknown> = {
        ...(raw.extra.metadata || {})
    };
    if (raw.extra.prism_features) {
        metadata.prism_features = raw.extra.prism_features;
    }

    return {
        ruleId: raw.check_id,
        ruleName: raw.check_id,
        category: normalizeSemgrepCategory(raw.extra.metadata?.category),
        severity: normalizeSemgrepSeverity(raw.extra.severity),
        sourceSeverity: raw.extra.severity,
        message: raw.extra.message,
        filePath,
        startLine: raw.start.line,
        endLine: raw.end.line,
        startCol: raw.start.col,
        endCol: raw.end.col,
        codeSnippet: snippet,
        fingerprint,
        metadata
    };
}
