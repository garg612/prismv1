/**
 * Turns a unified diff into per-file views the logic review can reason about and be checked against:
 * every new-side line with its real line number, and which of those lines the PR added.
 */

export interface DiffFile {
    /** Repository-relative path on the new side */
    path: string;
    /** New-side line number -> text, for added and context lines shown in the diff */
    lines: Map<number, string>;
    /** New-side line numbers the PR added or changed */
    added: Set<number>;
}

export function parseDiffFiles(diffText: string): DiffFile[] {
    const files: DiffFile[] = [];
    let current: DiffFile | null = null;
    let newLine = 0;
    let inHunk = false;

    for (const raw of String(diffText || "").split("\n")) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

        if (line.startsWith("diff --git ")) {
            current = null;
            inHunk = false;
            continue;
        }
        if (!inHunk && line.startsWith("+++ ")) {
            // "+++ /dev/null" is a deleted file: nothing on the new side to review
            if (line.startsWith("+++ b/")) {
                current = { path: line.substring(6), lines: new Map(), added: new Set() };
                files.push(current);
            } else {
                current = null;
            }
            continue;
        }
        if (line.startsWith("@@ ")) {
            const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            inHunk = !!match && !!current;
            if (match) newLine = parseInt(match[1], 10);
            continue;
        }
        if (!inHunk || !current) continue;

        if (line.startsWith("+")) {
            current.lines.set(newLine, line.substring(1));
            current.added.add(newLine);
            newLine++;
        } else if (line.startsWith(" ")) {
            current.lines.set(newLine, line.substring(1));
            newLine++;
        } else if (line.startsWith("-") || line.startsWith("\\")) {
            // removed line, or "\ No newline at end of file": not on the new side
        } else if (line === "") {
            // A blank context line whose leading space was stripped in transit
            current.lines.set(newLine, "");
            newLine++;
        } else {
            inHunk = false;
        }
    }

    return files;
}

const CODE_EXTENSIONS = new Set([
    "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
    "py", "go", "java", "kt", "kts", "rb", "php", "cs", "rs", "swift", "scala",
    "c", "cc", "cpp", "cxx", "h", "hpp", "m", "mm", "sql", "sh", "bash", "vue", "svelte",
]);

const SKIPPED_PATHS = [
    /(^|\/)node_modules\//, /(^|\/)vendor\//, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)out\//, /(^|\/)coverage\//,
    /(^|\/)\.next\//, /(^|\/)generated\//, /(^|\/)__snapshots__\//,
    /\.min\.(js|css)$/, /\.bundle\.js$/, /\.d\.ts$/, /\.map$/, /\.snap$/, /\.lock$/, /-lock\.(json|yaml)$/,
];

/** Source code a human wrote, as opposed to data, generated output or dependencies. */
export function isReviewableFile(path: string): boolean {
    if (SKIPPED_PATHS.some(pattern => pattern.test(path))) return false;
    const extension = path.includes(".") ? path.substring(path.lastIndexOf(".") + 1).toLowerCase() : "";
    return CODE_EXTENSIONS.has(extension);
}

/** One file as shown to the model: real line numbers, "+" on the lines the PR added. */
export function renderDiffFile(file: DiffFile): string {
    const numbers = Array.from(file.lines.keys()).sort((a, b) => a - b);
    const out: string[] = [`### ${file.path}`];
    let previous: number | null = null;
    for (const n of numbers) {
        if (previous !== null && n !== previous + 1) out.push("  ...");
        out.push(`${file.added.has(n) ? "+" : " "} ${String(n).padStart(5)} | ${file.lines.get(n)}`);
        previous = n;
    }
    return out.join("\n");
}

export interface DiffSelection {
    /** Files included in the prompt */
    reviewed: DiffFile[];
    /** Changed code files left out because the prompt budget was reached */
    overBudget: string[];
    /** Changed files that are not reviewable source code, or changed nothing on the new side */
    notReviewable: string[];
    rendered: string;
}

/**
 * Choose what goes into the prompt. Files are taken in diff order until the character budget is
 * reached; a file is never cut in half, so every reviewed file is reviewed whole.
 */
export function selectFilesForReview(files: DiffFile[], maxChars: number): DiffSelection {
    const reviewed: DiffFile[] = [];
    const overBudget: string[] = [];
    const notReviewable: string[] = [];
    const parts: string[] = [];
    let used = 0;

    for (const file of files) {
        if (!isReviewableFile(file.path) || file.added.size === 0) {
            notReviewable.push(file.path);
            continue;
        }
        const rendered = renderDiffFile(file);
        if (used + rendered.length > maxChars) {
            overBudget.push(file.path);
            continue;
        }
        reviewed.push(file);
        parts.push(rendered);
        used += rendered.length + 2;
    }

    return { reviewed, overBudget, notReviewable, rendered: parts.join("\n\n") };
}
