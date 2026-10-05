import type { Hunk } from "@/modules/review/lib/diff-hunks";
import { eslintSeverityText, ruleFamily } from "./rules";
import type { EslintFindingMetadata } from "./schema";

/** The request body of the ESLint triage model, one per finding. Field names are the model's. */
export interface EslintMLFeatures {
    message: string;
    rule_id: string;
    rule_family: string;
    severity_text: string;
    language: string;
    path_extension: string;
    severity: number;
    is_error: number;
    is_warning: number;
    message_length: number;
    message_word_count: number;
    start_line: number;
    start_column: number;
    end_line: number;
    end_column: number;
    finding_span_lines: number;
    finding_span_columns: number;
    has_fix: number;
    fix_text_length: number;
    fix_range_length: number;
    has_suggestions: number;
    suggestion_count: number;
    changed_line_start: number | null;
    changed_line_end: number | null;
    changed_line_count: number | null;
    finding_overlaps_change: number;
    finding_change_distance: number | null;
    file_size_lines: number;
    finding_start_line_ratio: number;
    pr_change_code_lines: number;
    base_file_finding_count: number;
    base_rule_finding_count: number;
    base_file_has_findings: number;
    base_rule_exists_in_file: number;
    prior_findings_in_file: number;
    pr_total_findings_in_file: number;
    same_rule_findings_in_file: number;
    same_rule_findings_in_repo: number;
    path_depth: number;
    path_has_test: number;
    path_has_src: number;
    path_has_config: number;
    path_has_generated: number;
}

/** The fields of a stored finding the features are computed from */
export interface EslintFeatureFinding {
    id: string;
    ruleId: string;
    message: string;
    filePath: string;
    startLine: number;
    endLine: number;
    startCol: number | null;
    endCol: number | null;
    metadata: unknown;
}

export interface EslintFeatureContext {
    /** New-side line ranges the pull request changes, per file */
    fileHunks: Map<string, Hunk[]>;
    /** Changed lines in the whole pull request */
    totalChangedLines: number;
    /** Every ESLint finding on the head commit, including the one being described */
    headFindings: Array<{ id: string; ruleId: string; filePath: string; startLine: number; startCol: number | null }>;
    /** Every ESLint finding on the base commit */
    baseFindings: Array<{ ruleId: string; filePath: string }>;
}

const LANGUAGE: Record<string, string> = {
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
};
const bit = (v: boolean) => (v ? 1 : 0);
const has = (segments: string[], pattern: RegExp) => bit(segments.some(s => pattern.test(s)));

/** The changed range nearest to the finding: the one it overlaps, else the closest by line. */
function nearestHunk(hunks: Hunk[], start: number, end: number): { hunk: Hunk; distance: number } | null {
    let best: { hunk: Hunk; distance: number } | null = null;
    for (const hunk of hunks) {
        const distance = start > hunk.end ? start - hunk.end : end < hunk.start ? hunk.start - end : 0;
        if (!best || distance < best.distance) best = { hunk, distance };
    }
    return best;
}

/**
 * Describe one ESLint finding for the triage model. Returns null when a measured input is
 * missing (the finding was not stored by the ESLint adapter): a value is never made up, the
 * finding is routed by the standard rules instead.
 */
export function buildEslintFeatures(finding: EslintFeatureFinding, ctx: EslintFeatureContext): EslintMLFeatures | null {
    const meta = (finding.metadata as { eslint?: Partial<EslintFindingMetadata> } | null)?.eslint;
    if (!meta || (meta.severity !== 1 && meta.severity !== 2) || !Number.isInteger(meta.fileSizeLines) || (meta.fileSizeLines as number) < 1) return null;

    const dot = finding.filePath.lastIndexOf(".");
    const extension = dot >= 0 ? finding.filePath.slice(dot).toLowerCase() : "";
    const language = LANGUAGE[extension];
    if (!language) return null;

    const segments = finding.filePath.toLowerCase().split("/");
    const startColumn = finding.startCol ?? 0;
    const endColumn = finding.endCol ?? startColumn;
    const near = nearestHunk(ctx.fileHunks.get(finding.filePath) || [], finding.startLine, finding.endLine);

    const inFile = ctx.headFindings.filter(f => f.filePath === finding.filePath);
    const before = (f: { startLine: number; startCol: number | null }) =>
        f.startLine < finding.startLine || (f.startLine === finding.startLine && (f.startCol ?? 0) < startColumn);
    const baseInFile = ctx.baseFindings.filter(f => f.filePath === finding.filePath);
    const baseRuleInFile = baseInFile.filter(f => f.ruleId === finding.ruleId).length;

    return {
        message: finding.message,
        rule_id: finding.ruleId,
        rule_family: meta.ruleFamily || ruleFamily(finding.ruleId),
        severity_text: eslintSeverityText(meta.severity),
        language,
        path_extension: extension,
        severity: meta.severity,
        is_error: bit(meta.severity === 2),
        is_warning: bit(meta.severity === 1),
        message_length: finding.message.length,
        message_word_count: finding.message.trim().split(/\s+/).filter(Boolean).length,
        start_line: finding.startLine,
        start_column: startColumn,
        end_line: finding.endLine,
        end_column: endColumn,
        finding_span_lines: finding.endLine - finding.startLine + 1,
        finding_span_columns: Math.max(0, endColumn - startColumn),
        has_fix: bit(!!meta.hasFix),
        fix_text_length: meta.fixTextLength ?? 0,
        fix_range_length: meta.fixRangeLength ?? 0,
        has_suggestions: bit((meta.suggestionCount ?? 0) > 0),
        suggestion_count: meta.suggestionCount ?? 0,
        changed_line_start: near ? near.hunk.start : null,
        changed_line_end: near ? near.hunk.end : null,
        changed_line_count: near ? near.hunk.end - near.hunk.start + 1 : null,
        finding_overlaps_change: bit(!!near && near.distance === 0),
        finding_change_distance: near ? near.distance : null,
        file_size_lines: meta.fileSizeLines as number,
        finding_start_line_ratio: Number((finding.startLine / (meta.fileSizeLines as number)).toFixed(3)),
        pr_change_code_lines: ctx.totalChangedLines,
        base_file_finding_count: baseInFile.length,
        base_rule_finding_count: baseRuleInFile,
        base_file_has_findings: bit(baseInFile.length > 0),
        base_rule_exists_in_file: bit(baseRuleInFile > 0),
        prior_findings_in_file: inFile.filter(f => f.id !== finding.id && before(f)).length,
        pr_total_findings_in_file: inFile.length,
        same_rule_findings_in_file: inFile.filter(f => f.ruleId === finding.ruleId).length,
        same_rule_findings_in_repo: ctx.headFindings.filter(f => f.ruleId === finding.ruleId).length,
        path_depth: segments.length - 1,
        path_has_test: has(segments, /^(tests?|__tests__|spec|specs)$|\.(test|spec)\./),
        path_has_src: has(segments, /^src$/),
        path_has_config: has(segments, /^(config|configs|\.config)$|\.config\.|rc\./),
        path_has_generated: has(segments, /^(generated|gen|dist|build)$|\.generated\./),
    };
}
