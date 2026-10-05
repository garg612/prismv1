import { SCANNER_CATALOG } from "../catalog";
import type { ScannerAdapter } from "../types";
import { getRulesetId } from "@/modules/scanners/semgrep/ruleset";
import { evaluateScanCallback } from "@/modules/scanners/semgrep/scan-result";
import { scoreSemgrepFindings } from "@/modules/triage/lib/scoring";

export const semgrepScanner: ScannerAdapter = {
    id: "SEMGREP",
    displayName: SCANNER_CATALOG.SEMGREP.displayName,
    rescanCheck: SCANNER_CATALOG.SEMGREP.rescanCheck,
    getRulesetId,
    evaluateScan: evaluateScanCallback,
    scoreFindings: scoreSemgrepFindings,
};
