import type { Severity } from '@/generated/prisma/client';
import { toRepoRelativePath } from '@/modules/scanners/semgrep/path';

export interface DeltaStats {
    targetFindingStatus: 'REMOVED' | 'UNCHANGED';
    newFindingsCount: number;
    partiallyFixed: boolean;
}

/** The part of a normalized finding the delta needs. Works for any scanner. */
export interface DeltaFinding {
    ruleId: string;
    filePath: string;
    fingerprint: string;
    severity: Severity;
    startLine: number;
}

function matchKey(finding: { ruleId: string; filePath: string; fingerprint: string }): string {
    return `${finding.ruleId}:${toRepoRelativePath(finding.filePath)}:${finding.fingerprint}`;
}

/**
 * Compare one scanner's findings before and after a proposed fix.
 * Both lists must come from the same scanner and be normalized the same way.
 */
export function computeDelta(
    target: { ruleId: string; filePath: string; fingerprint: string },
    headFindings: DeltaFinding[],
    postFixFindings: DeltaFinding[]
): { deltas: any[], stats: DeltaStats } {
    const headMap = new Map<string, number>();
    for (const f of headFindings) {
        const key = matchKey(f);
        headMap.set(key, (headMap.get(key) || 0) + 1);
    }

    const postMap = new Map<string, number>();
    for (const f of postFixFindings) {
        const key = matchKey(f);
        postMap.set(key, (postMap.get(key) || 0) + 1);
    }

    const deltas: any[] = [];
    let targetFindingRemoved = false;
    let newFindingsCount = 0;

    // Check target finding status
    const targetPath = toRepoRelativePath(target.filePath);
    const targetKey = matchKey(target);
    const targetHeadCount = headMap.get(targetKey) || 0;
    const targetPostCount = postMap.get(targetKey) || 0;

    if (targetHeadCount > 0) {
        // A finding is one occurrence. When the same code appears several times in a file, each
        // occurrence is its own finding with its own fix, so one fewer match means this one is fixed.
        targetFindingRemoved = targetPostCount < targetHeadCount;
    } else {
        targetFindingRemoved = true; // Wasn't there originally somehow
    }

    // Determine ADDED
    for (const f of postFixFindings) {
        if (f.severity === 'INFO') continue; // Do not penalize INFO level style changes

        const key = matchKey(f);
        const headC = headMap.get(key) || 0;
        const postC = postMap.get(key) || 0;

        if (postC > headC) {
            newFindingsCount++;
            deltas.push({
                fingerprint: f.fingerprint,
                ruleId: f.ruleId,
                filePath: toRepoRelativePath(f.filePath),
                line: f.startLine, // Keep line just for reporting where it is now
                severity: f.severity,
                delta: "ADDED"
            });
            postMap.set(key, headC); // Reduce postMap so we only add it once per new finding
        }
    }

    // Record the target finding outcome
    deltas.push({
        fingerprint: target.fingerprint,
        ruleId: target.ruleId,
        filePath: targetPath,
        line: 0, // Line number might not apply if removed
        severity: "HIGH",
        delta: targetFindingRemoved ? "REMOVED" : "UNCHANGED"
    });

    return {
        deltas,
        stats: {
            targetFindingStatus: targetFindingRemoved ? 'REMOVED' : 'UNCHANGED',
            newFindingsCount,
            // Identical occurrences that remain belong to other findings; they do not make this fix partial.
            partiallyFixed: false
        }
    };
}
