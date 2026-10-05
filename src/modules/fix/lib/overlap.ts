// overlap types

export type OverlapStatus = 'NON_OVERLAPPING' | 'OVERLAPPING' | 'CONFLICTING' | 'UNKNOWN';

export interface OverlapResult {
    status: OverlapStatus;
    reason?: string;
}

export function detectOverlap(fixA: any, fixB: any, baseContents: Record<string, string>): OverlapResult {
    // Determine if fixA and fixB overlap.
    const editsA: any[] = fixA.edits as any[];
    const editsB: any[] = fixB.edits as any[];

    if (!editsA || !editsB) return { status: 'UNKNOWN', reason: 'Missing edits' };

    for (const editA of editsA) {
        for (const editB of editsB) {
            if (editA.path === editB.path) {
                const content = baseContents[editA.path];
                if (!content) {
                    return { status: 'UNKNOWN', reason: `Missing base content for ${editA.path}` };
                }

                const indexA = content.indexOf(editA.find);
                const indexB = content.indexOf(editB.find);

                if (indexA === -1 || indexB === -1) {
                    return { status: 'UNKNOWN', reason: `Edit find string not found in base content for ${editA.path}` };
                }

                // Make sure there's only one occurrence to be safe
                if (content.indexOf(editA.find, indexA + 1) !== -1 || content.indexOf(editB.find, indexB + 1) !== -1) {
                    return { status: 'CONFLICTING', reason: `Ambiguous multiple occurrences of find string in ${editA.path}` };
                }

                const startLineA = content.slice(0, indexA).split('\n').length;
                const endLineA = startLineA + editA.find.split('\n').length - 1;

                const startLineB = content.slice(0, indexB).split('\n').length;
                const endLineB = startLineB + editB.find.split('\n').length - 1;

                // Check for line range overlap or strict adjacency
                if (startLineA <= endLineB && startLineB <= endLineA) {
                    return { status: 'CONFLICTING', reason: `Overlapping lines in ${editA.path} (${startLineA}-${endLineA} and ${startLineB}-${endLineB})` };
                }

                // If they are adjacent (e.g. endA == startB - 1), we treat it conservatively as conflicting
                if (endLineA === startLineB - 1 || endLineB === startLineA - 1) {
                    return { status: 'CONFLICTING', reason: `Adjacent lines in ${editA.path} (${startLineA}-${endLineA} and ${startLineB}-${endLineB})` };
                }
            }
        }
    }

    return { status: 'NON_OVERLAPPING' };
}

export function buildCombinedPatch(fixes: any[], baseContents: Record<string, string>) {
    // 1. Ensure all fixes have same validatedHeadSha
    const headShas = new Set(fixes.map(f => f.validatedHeadSha));
    if (headShas.size > 1) {
        throw new Error('Fixes have different validatedHeadSha');
    }
    const headSha = headShas.values().next().value;

    // 2. Detect overlaps pairwise
    for (let i = 0; i < fixes.length; i++) {
        for (let j = i + 1; j < fixes.length; j++) {
            const overlap = detectOverlap(fixes[i], fixes[j], baseContents);
            if (overlap.status !== 'NON_OVERLAPPING') {
                throw new Error(`Conflict between fix ${fixes[i].id} and ${fixes[j].id}: ${overlap.reason}`);
            }
        }
    }

    // 3. Combine edits
    const combinedEdits: any[] = [];
    for (const fix of fixes) {
        combinedEdits.push(...(fix.edits as any[]));
    }

    // 4. Return combined proposal format suitable for generateDeterministicPatch
    return {
        findingId: 'COMBINED',
        explanation: 'Combined fix',
        edits: combinedEdits,
        riskNotes: '',
        selfConfidence: 1,
        includedFixIds: fixes.map(f => f.id).sort()
    };
}
