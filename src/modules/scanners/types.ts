import { FindingCategory, Severity } from "@/generated/prisma/client";
import type { ScannerId } from "./catalog";
import type { ScoreFindings } from "@/modules/triage/lib/scoring";

/** A finding in PRism's own vocabulary. Everything after the scan stage works on this shape only. */
export interface NormalizedFinding {
    ruleId: string;
    ruleName?: string;
    category: FindingCategory;
    severity: Severity;
    /** The severity exactly as the tool reported it */
    sourceSeverity: string;
    message: string;
    /** Repository-relative, forward slashes */
    filePath: string;
    startLine: number;
    endLine: number;
    startCol?: number;
    endCol?: number;
    /** The real source text of the flagged lines */
    codeSnippet?: string;
    /** generateFingerprint(ruleId, filePath, codeSnippet): stable across line shifts */
    fingerprint: string;
    metadata?: Record<string, unknown>;
}

/** What the runner sends back for a scan or re-scan job. `toolResult` is the tool's own output. */
export interface ScanCallbackData {
    status: string;
    error?: string;
    errorCode?: string;
    tool?: string;
    toolResult?: unknown;
}

export type ScanEvaluation =
    | {
        ok: true;
        findings: NormalizedFinding[];
        /** Non-fatal tool diagnostics (e.g. files the tool could only partially parse) */
        toolWarnings: unknown[];
        scannedFiles: number | null;
        toolVersion: string | null;
    }
    | {
        ok: false;
        code: string;
        error: string;
        jobStatus: "FAILED" | "TIMEOUT";
    };

/**
 * Everything the pipeline needs to know about one scanning tool.
 *
 * To add a tool: implement this, register it in registry.ts, add its entry to catalog.ts,
 * add its re-scan check to the CheckName enum, and add the matching runner scanner in
 * services/runner/src/scanners.
 */
export interface ScannerAdapter {
    id: ScannerId;
    displayName: string;
    /** ValidationCheck recorded when this scanner re-scans a proposed fix */
    rescanCheck: string;
    /** Identifies the exact rules/config used, stored on each ScanRun */
    getRulesetId(): string;
    /**
     * Turn a runner callback (or its absence) into normalized findings or an explicit failure.
     * Must fail closed: an empty finding list is only valid for a scan that fully completed.
     */
    evaluateScan(data: ScanCallbackData | null | undefined): ScanEvaluation;
    /**
     * Ask this scanner's triage model about its findings. Returns one entry per finding: a score
     * with the model's own bar, or an explicit reason there is none. Must not throw for a model
     * that is down or misconfigured; those findings are then routed by the standard rules.
     */
    scoreFindings: ScoreFindings;
}
