import { generateFingerprint } from "@/modules/scanners/semgrep/fingerprint";
import { toRepoRelativePath } from "@/modules/scanners/semgrep/path";
import type { NormalizedFinding, ScanCallbackData, ScanEvaluation } from "@/modules/scanners/types";
import { eslintCategory, eslintSeverity, eslintSeverityText, ruleFamily } from "./rules";
import { EslintFile, EslintFindingMetadata, EslintMessage, EslintResultSchema } from "./schema";

export function normalizeEslintMessage(file: EslintFile, message: EslintMessage & { ruleId: string }): NormalizedFinding {
    // The runner emits repository-relative paths; anything else is rejected, not rewritten.
    const filePath = toRepoRelativePath(file.filePath);
    const eslint: EslintFindingMetadata = {
        severity: message.severity,
        ruleFamily: ruleFamily(message.ruleId),
        hasFix: message.fix !== null,
        fixTextLength: message.fix ? message.fix.text.length : 0,
        fixRangeLength: message.fix ? Math.max(0, message.fix.range[1] - message.fix.range[0]) : 0,
        suggestionCount: message.suggestionCount,
        fileSizeLines: file.fileSizeLines,
    };
    return {
        ruleId: message.ruleId,
        ruleName: message.ruleId,
        category: eslintCategory(message.ruleId),
        severity: eslintSeverity(message.severity),
        sourceSeverity: eslintSeverityText(message.severity),
        message: message.message,
        filePath,
        startLine: message.line,
        endLine: message.endLine,
        startCol: message.column ?? undefined,
        endCol: message.endColumn ?? undefined,
        codeSnippet: message.lines,
        // Several ESLint rules can flag the same line, and the rule is part of the fingerprint,
        // so each of them is its own finding.
        fingerprint: generateFingerprint(message.ruleId, filePath, message.lines),
        metadata: { eslint },
    };
}

/**
 * Turn a runner scan callback (or its absence) into either a trustworthy finding list or an
 * explicit failure. An empty finding list is only ever returned for a lint that ran to the end.
 */
export function evaluateEslintScan(data: ScanCallbackData | null | undefined): ScanEvaluation {
    if (!data) {
        return { ok: false, code: "SCAN_TIMEOUT", error: "No result was received from the runner in time", jobStatus: "TIMEOUT" };
    }
    if (data.status !== "COMPLETED") {
        return { ok: false, code: data.errorCode || "SCAN_FAILED", error: data.error || "Runner reported a failed scan", jobStatus: "FAILED" };
    }
    if (data.toolResult === undefined || data.toolResult === null) {
        return { ok: false, code: "SCAN_RESULT_MISSING", error: "Runner reported success without a scan result", jobStatus: "FAILED" };
    }
    // The callback carries the tool's output untyped; this is where ESLint's shape is enforced.
    const parsed = EslintResultSchema.safeParse(data.toolResult);
    if (!parsed.success) {
        return { ok: false, code: "SCAN_RESULT_INVALID", error: "Scan result is not valid ESLint output", jobStatus: "FAILED" };
    }
    const result = parsed.data;

    const findings: NormalizedFinding[] = [];
    const toolWarnings: unknown[] = [];
    try {
        for (const file of result.results) {
            for (const message of file.messages) {
                if (message.fatal) {
                    // ESLint could not parse this file, so it has no lint result. That is recorded
                    // on the scan; it is not turned into a finding, and the other files stand.
                    toolWarnings.push({ level: "warn", type: "ParseError", path: toRepoRelativePath(file.filePath), line: message.line, message: message.message.slice(0, 300) });
                } else if (message.ruleId === null) {
                    // A message from ESLint itself (for example about a directive comment), not from a rule.
                    toolWarnings.push({ level: "info", type: "LinterMessage", path: toRepoRelativePath(file.filePath), line: message.line, message: message.message.slice(0, 300) });
                } else {
                    findings.push(normalizeEslintMessage(file, { ...message, ruleId: message.ruleId }));
                }
            }
        }
        result.scanned.forEach(p => toRepoRelativePath(p));
    } catch (e: any) {
        return { ok: false, code: "SCAN_NON_CANONICAL_PATH", error: e?.message || "Scan result contains an invalid path", jobStatus: "FAILED" };
    }

    return { ok: true, findings, toolWarnings, scannedFiles: result.scanned.length, toolVersion: result.version };
}
