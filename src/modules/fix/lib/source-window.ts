export interface SourceWindow {
    path: string;
    /** 1-based, inclusive lines of the finding in the file */
    findingStartLine: number;
    findingEndLine: number;
    /** 1-based, inclusive lines of the file covered by `text` */
    windowStartLine: number;
    windowEndLine: number;
    totalLines: number;
    /** Verbatim file content for the window: no line numbers, no trimming */
    text: string;
    /** Verbatim file content for the finding lines only */
    findingText: string;
}

export interface SourceWindowOptions {
    contextLines?: number;
    maxChars?: number;
}

export class SourceWindowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SourceWindowError';
    }
}

const DEFAULT_CONTEXT_LINES = 40;
const DEFAULT_MAX_CHARS = 12000;

/**
 * Deterministic excerpt of a file around a finding: the finding lines plus up to
 * `contextLines` on each side, shrunk symmetrically until it fits `maxChars`.
 * The text is byte-for-byte what is in the file so a model can copy an exact `find` string.
 */
export function buildSourceWindow(
    path: string,
    content: string,
    findingStartLine: number,
    findingEndLine: number,
    options: SourceWindowOptions = {}
): SourceWindow {
    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

    const lines = content.split('\n');
    const totalLines = lines.length;

    if (!Number.isInteger(findingStartLine) || !Number.isInteger(findingEndLine) ||
        findingStartLine < 1 || findingEndLine < findingStartLine || findingEndLine > totalLines) {
        throw new SourceWindowError(
            `Finding lines ${findingStartLine}-${findingEndLine} are outside ${path} (${totalLines} lines)`
        );
    }

    const slice = (from: number, to: number) => lines.slice(from - 1, to).join('\n');
    const findingText = slice(findingStartLine, findingEndLine);

    let context = contextLines;
    let windowStartLine = Math.max(1, findingStartLine - context);
    let windowEndLine = Math.min(totalLines, findingEndLine + context);
    let text = slice(windowStartLine, windowEndLine);

    while (text.length > maxChars && context > 0) {
        context = Math.floor(context / 2);
        windowStartLine = Math.max(1, findingStartLine - context);
        windowEndLine = Math.min(totalLines, findingEndLine + context);
        text = slice(windowStartLine, windowEndLine);
    }

    if (text.length > maxChars) {
        throw new SourceWindowError(`Finding in ${path} spans ${text.length} characters, above the ${maxChars} limit`);
    }

    return { path, findingStartLine, findingEndLine, windowStartLine, windowEndLine, totalLines, text, findingText };
}

/** True when the scanner's snippet and the fetched source describe the same code. */
export function snippetMatchesSource(snippet: string | null | undefined, window: SourceWindow): boolean {
    if (!snippet) return true;
    const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();
    return normalize(snippet) === normalize(window.findingText);
}
