import { SCANNER_CATALOG } from "../catalog";
import type { ScannerAdapter } from "../types";
import { getEslintRulesetId } from "@/modules/scanners/eslint/ruleset";
import { evaluateEslintScan } from "@/modules/scanners/eslint/scan-result";
import { scoreEslintFindings } from "@/modules/triage/lib/scoring";

export const eslintScanner: ScannerAdapter = {
    id: "ESLINT",
    displayName: SCANNER_CATALOG.ESLINT.displayName,
    rescanCheck: SCANNER_CATALOG.ESLINT.rescanCheck,
    getRulesetId: getEslintRulesetId,
    evaluateScan: evaluateEslintScan,
    scoreFindings: scoreEslintFindings,
};
