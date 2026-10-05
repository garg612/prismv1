import { describe, it, expect } from 'vitest';

// We extract the pure logic from review-run.ts for testing
function parseDiffHunks(diffText: string): Map<string, Array<{start: number, end: number}>> {
    const fileHunks = new Map<string, Array<{start: number, end: number}>>();
    let currentFile = "";
    for (const line of diffText.split('\n')) {
        if (line.startsWith('+++ b/')) {
            currentFile = line.substring(6);
            if (!fileHunks.has(currentFile)) fileHunks.set(currentFile, []);
        } else if (line.startsWith('@@ ') && currentFile) {
            const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                const start = parseInt(match[1], 10);
                const count = match[2] ? parseInt(match[2], 10) : 1;
                fileHunks.get(currentFile)!.push({ start, end: start + count - 1 });
            }
        }
    }
    return fileHunks;
}

function processFindings(headFindings: any[], baseFindings: any[], diff: string) {
    const fileHunks = parseDiffHunks(diff);
    
    const baseFindingsMap = new Map<string, number>();
    for (const f of baseFindings) {
        baseFindingsMap.set(f.fingerprint, (baseFindingsMap.get(f.fingerprint) || 0) + 1);
    }

    const headFindingsMap = new Map<string, number>();
    for (const finding of headFindings) {
        headFindingsMap.set(finding.fingerprint, (headFindingsMap.get(finding.fingerprint) || 0) + 1);
        finding.occurrence = headFindingsMap.get(finding.fingerprint);
    }

    return headFindings.map(finding => {
        const occurrence = finding.occurrence || 1;
        const baseCount = baseFindingsMap.get(finding.fingerprint) || 0;
        const isPreexisting = occurrence <= baseCount;

        const hunks = fileHunks.get(finding.filePath) || [];
        const inChangedLines = hunks.some(h => 
            finding.startLine <= h.end && (finding.endLine || finding.startLine) >= h.start
        );

        return { ...finding, isPreexisting, inChangedLines };
    });
}

describe('Finding Diffing & Deduplication', () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -10,3 +10,5 @@
 function old() {}
+function new() {}
+console.log(1);`;

    it('identifies unchanged finding existing in BASE and HEAD', () => {
        const head = [{ fingerprint: 'hashA', filePath: 'file.ts', startLine: 2, endLine: 2 }];
        const base = [{ fingerprint: 'hashA', filePath: 'file.ts', startLine: 2, endLine: 2 }];
        const result = processFindings(head, base, diff);
        expect(result[0].isPreexisting).toBe(true);
        expect(result[0].inChangedLines).toBe(false);
    });

    it('identifies newly introduced finding', () => {
        const head = [{ fingerprint: 'hashB', filePath: 'file.ts', startLine: 11, endLine: 12 }];
        const base: any[] = [];
        const result = processFindings(head, base, diff);
        expect(result[0].isPreexisting).toBe(false);
        expect(result[0].inChangedLines).toBe(true);
    });

    it('handles same finding after line-number shift', () => {
        const head = [{ fingerprint: 'hashC', filePath: 'file.ts', startLine: 20, endLine: 20 }];
        const base = [{ fingerprint: 'hashC', filePath: 'file.ts', startLine: 18, endLine: 18 }]; // shifted
        const result = processFindings(head, base, diff);
        expect(result[0].isPreexisting).toBe(true);
        expect(result[0].inChangedLines).toBe(false); // 20 is not in diff
    });

    it('handles multiple occurrences of identical findings (new)', () => {
        const head = [
            { fingerprint: 'hashD', filePath: 'file.ts', startLine: 11, endLine: 11 },
            { fingerprint: 'hashD', filePath: 'file.ts', startLine: 12, endLine: 12 }
        ];
        const base = [
            { fingerprint: 'hashD', filePath: 'file.ts', startLine: 2, endLine: 2 }
        ];
        const result = processFindings(head, base, diff);
        expect(result[0].isPreexisting).toBe(true); // First occurrence is preexisting
        expect(result[1].isPreexisting).toBe(false); // Second occurrence is new
    });

    it('finding spanning changed and unchanged lines', () => {
        const head = [{ fingerprint: 'hashE', filePath: 'file.ts', startLine: 9, endLine: 12 }];
        const result = processFindings(head, [], diff);
        expect(result[0].inChangedLines).toBe(true); // hunk is 10-14, spans 9-12
    });
});
