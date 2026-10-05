import type { DiffFile } from "./diff-files";
import type { AcceptedLogicIssue, LogicIssue, ToolFindingRef } from "./schema";

export const MAX_LOGIC_ISSUES = 8;
const MAX_ISSUE_SPAN_LINES = 40;
/** How far from the stated line the quoted code may be found before the issue is rejected */
const QUOTE_SEARCH_WINDOW = 3;
/** A logic issue this close to a scanner finding is treated as the same problem */
const TOOL_OVERLAP_MARGIN = 1;

export type DiscardReason =
    | "unknown-file"
    | "invalid-lines"
    | "quote-mismatch"
    | "not-on-changed-lines"
    | "low-confidence"
    | "reported-by-tool"
    | "duplicate"
    | "over-limit";

export interface ValidationResult {
    accepted: AcceptedLogicIssue[];
    discarded: Partial<Record<DiscardReason, number>>;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => {
    const clean = String(text ?? "").trim();
    return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
};

const SEVERITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
const CONFIDENCE_RANK = { HIGH: 0, MEDIUM: 1 } as const;

/** Where in [from, to] the quoted text actually is, or null. Blank quotes never match. */
function findQuotedLine(file: DiffFile, quoted: string, from: number, to: number): number | null {
    const wanted = normalize(quoted);
    if (wanted.length < 3) return null;
    for (let n = from; n <= to; n++) {
        const actual = file.lines.get(n);
        if (actual === undefined) continue;
        const text = normalize(actual);
        if (!text) continue;
        // Exact match, or one contains the other when the shorter side is long enough to be distinctive
        if (text === wanted) return n;
        if (wanted.length >= 8 && text.includes(wanted)) return n;
        if (text.length >= 8 && wanted.includes(text)) return n;
    }
    return null;
}

/**
 * Decide which of the model's issues are kept. An issue survives only if it can be tied to real
 * code: a reviewed file, real line numbers, a quote that matches what is on those lines, and at
 * least one line the PR itself changed. Issues a scanner already reported are dropped here too,
 * so the two kinds of finding never describe the same problem.
 */
export function validateLogicIssues(issues: LogicIssue[], reviewed: DiffFile[], toolFindings: ToolFindingRef[]): ValidationResult {
    const byPath = new Map(reviewed.map(file => [file.path, file]));
    const discarded: Partial<Record<DiscardReason, number>> = {};
    const drop = (reason: DiscardReason) => { discarded[reason] = (discarded[reason] || 0) + 1; };
    const kept: AcceptedLogicIssue[] = [];
    const seen = new Set<string>();

    for (const issue of issues) {
        const path = String(issue.filePath || "").replace(/^\.?\//, "").replace(/^[ab]\//, "");
        const file = byPath.get(path) ?? byPath.get(String(issue.filePath || ""));
        if (!file) { drop("unknown-file"); continue; }

        let start = issue.startLine;
        let end = Math.max(issue.endLine, issue.startLine);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end - start > MAX_ISSUE_SPAN_LINES) {
            drop("invalid-lines");
            continue;
        }

        // The quote anchors the issue to real code. If it sits a line or two away from where the
        // model said, the issue moves to where the code really is; if it is nowhere near, it is dropped.
        const quotedAt = findQuotedLine(file, issue.quotedLine, start, end)
            ?? findQuotedLine(file, issue.quotedLine, start - QUOTE_SEARCH_WINDOW, end + QUOTE_SEARCH_WINDOW);
        if (quotedAt === null) { drop("quote-mismatch"); continue; }
        if (quotedAt < start || quotedAt > end) {
            start = quotedAt;
            end = quotedAt;
        }

        const lineNumbers: number[] = [];
        for (let n = start; n <= end; n++) if (file.lines.has(n)) lineNumbers.push(n);
        if (!lineNumbers.some(n => file.added.has(n))) { drop("not-on-changed-lines"); continue; }

        if (issue.confidence === "LOW") { drop("low-confidence"); continue; }

        const overlapsTool = toolFindings.some(tool =>
            tool.filePath === file.path &&
            start <= tool.endLine + TOOL_OVERLAP_MARGIN &&
            end >= tool.startLine - TOOL_OVERLAP_MARGIN
        );
        if (overlapsTool) { drop("reported-by-tool"); continue; }

        const key = `${file.path}:${start}`;
        if (seen.has(key)) { drop("duplicate"); continue; }
        seen.add(key);

        kept.push({
            filePath: file.path,
            startLine: start,
            endLine: end,
            codeSnippet: lineNumbers.map(n => file.lines.get(n)).join("\n"),
            title: clip(issue.title, 160),
            explanation: clip(issue.explanation, 1500),
            suggestion: clip(issue.suggestion, 1000),
            category: issue.category,
            severity: issue.severity,
            confidence: issue.confidence,
        });
    }

    kept.sort((a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine
    );

    const accepted = kept.slice(0, MAX_LOGIC_ISSUES);
    if (kept.length > accepted.length) discarded["over-limit"] = kept.length - accepted.length;

    return { accepted: accepted.filter(issue => issue.title && issue.explanation), discarded };
}
