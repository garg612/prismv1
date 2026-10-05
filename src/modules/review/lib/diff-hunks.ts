export interface Hunk {
    start: number;
    end: number;
}

/** New-side line ranges per file from a unified diff, keyed by repository-relative path. */
export function parseDiffHunks(diffText: string): Map<string, Hunk[]> {
    const fileHunks = new Map<string, Hunk[]>();
    let currentFile = "";
    for (const line of diffText.split('\n')) {
        if (line.startsWith('+++ b/')) {
            currentFile = line.substring(6);
            if (!fileHunks.has(currentFile)) fileHunks.set(currentFile, []);
        } else if (line.startsWith('+++ ')) {
            currentFile = ""; // e.g. "+++ /dev/null" for a deleted file
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

export function isInChangedLines(fileHunks: Map<string, Hunk[]>, filePath: string, startLine: number, endLine: number): boolean {
    const hunks = fileHunks.get(filePath) || [];
    return hunks.some(h => startLine <= h.end && endLine >= h.start);
}
