import { describe, expect, it } from "vitest";
import { getEnabledScanners, getScanner, ScannerConfigError } from "../../src/modules/scanners/registry";
import { isRescanCheck, scannerDisplayName, SCANNER_CATALOG } from "../../src/modules/scanners/catalog";
import { computeDelta } from "../../src/modules/validation/lib/delta";
import { getScanner as getRunnerScanner, listScannerIds } from "../../services/runner/src/scanners";

const semgrepOutput = (lines: string) => ({
    version: "1.178.0",
    results: [{
        check_id: "prism-sql-injection",
        path: "lib/users.js",
        start: { line: 14, col: 12 },
        end: { line: 14, col: 60 },
        extra: { message: "Potential SQL injection", severity: "ERROR", lines, metadata: { category: "SECURITY" } }
    }],
    errors: [],
    paths: { scanned: ["lib/users.js"] }
});

describe("scanner registry", () => {
    it("runs Semgrep by default", () => {
        expect(getEnabledScanners(undefined).map(s => s.id)).toEqual(["SEMGREP"]);
    });

    it("reads the enabled scanners from configuration, ignoring case, spacing and repeats", () => {
        expect(getEnabledScanners(" semgrep , SEMGREP ").map(s => s.id)).toEqual(["SEMGREP"]);
    });

    it("refuses a scanner that is configured but not registered, instead of skipping it", () => {
        expect(() => getEnabledScanners("SEMGREP,BANDIT")).toThrow(ScannerConfigError);
        expect(() => getEnabledScanners(" , ")).toThrow(ScannerConfigError);
        expect(() => getScanner("BANDIT")).toThrow(ScannerConfigError);
    });

    it("has a runner scanner for every app-side scanner, under the same id", () => {
        expect(listScannerIds().sort()).toEqual(Object.keys(SCANNER_CATALOG).sort());
        expect(getRunnerScanner("BANDIT")).toBeUndefined();
        expect(getRunnerScanner("constructor")).toBeUndefined();
    });
});

describe("scanner adapter contract (Semgrep)", () => {
    const scanner = getScanner("SEMGREP");

    it("normalizes the tool's own output from the neutral callback field", () => {
        const evaluation = scanner.evaluateScan({ status: "COMPLETED", tool: "SEMGREP", toolResult: semgrepOutput('db.query("a" + id + "b")') });
        expect(evaluation.ok).toBe(true);
        if (!evaluation.ok) return;
        expect(evaluation.findings).toHaveLength(1);
        expect(evaluation.findings[0]).toMatchObject({ ruleId: "prism-sql-injection", filePath: "lib/users.js", severity: "HIGH", category: "SECURITY", startLine: 14 });
        expect(evaluation.toolVersion).toBe("1.178.0");
        expect(evaluation.scannedFiles).toBe(1);
    });

    it("fails closed on a missing callback, a missing result and a result of the wrong shape", () => {
        expect(scanner.evaluateScan(null)).toMatchObject({ ok: false, code: "SCAN_TIMEOUT" });
        expect(scanner.evaluateScan({ status: "COMPLETED" })).toMatchObject({ ok: false, code: "SCAN_RESULT_MISSING" });
        expect(scanner.evaluateScan({ status: "COMPLETED", toolResult: [{ ruleId: "no-unused-vars" }] })).toMatchObject({ ok: false, code: "SCAN_RESULT_INVALID" });
        expect(scanner.evaluateScan({ status: "FAILED", errorCode: "SCAN_TOOL_UNSUPPORTED", error: "x" })).toMatchObject({ ok: false, code: "SCAN_TOOL_UNSUPPORTED" });
    });

    it("feeds the scanner-neutral delta: the same adapter normalizes before and after", () => {
        const before = scanner.evaluateScan({ status: "COMPLETED", toolResult: semgrepOutput('db.query("a" + id + "b")') });
        const after = scanner.evaluateScan({ status: "COMPLETED", toolResult: { ...semgrepOutput(""), results: [] } });
        if (!before.ok || !after.ok) throw new Error("expected both scans to evaluate");

        const target = before.findings[0];
        expect(computeDelta(target, before.findings, after.findings).stats).toMatchObject({ targetFindingStatus: "REMOVED", newFindingsCount: 0 });
        expect(computeDelta(target, before.findings, before.findings).stats.targetFindingStatus).toBe("UNCHANGED");
    });
});

describe("scanner catalog", () => {
    it("names scanners for the review page and recognises their re-scan checks", () => {
        expect(scannerDisplayName("SEMGREP")).toBe("Semgrep");
        expect(scannerDisplayName("SOMETHING_ELSE")).toBe("The scanner");
        expect(scannerDisplayName(undefined)).toBe("The scanner");
        expect(isRescanCheck("SEMGREP_RESCAN")).toBe(true);
        expect(isRescanCheck("SYNTAX")).toBe(false);
    });
});
