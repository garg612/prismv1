/**
 * Static facts about each scanner. Pure data, safe to import from UI code.
 *
 * The keys are FindingSource values: that is the scanner's id everywhere — on ScanRun.source,
 * Finding.source, and as the `tool` field of runner jobs and callbacks.
 */
export const SCANNER_CATALOG = {
    SEMGREP: {
        displayName: "Semgrep",
        /** ValidationCheck recorded when this scanner re-scans a proposed fix */
        rescanCheck: "SEMGREP_RESCAN",
    },
    ESLINT: {
        displayName: "ESLint",
        rescanCheck: "ESLINT_RESCAN",
    },
} as const;

export type ScannerId = keyof typeof SCANNER_CATALOG;

/** The runner reports the re-scan under this neutral key; the app stores it as the scanner's own check. */
export const RUNNER_RESCAN_KEY = "RESCAN";

export function isScannerId(value: string): value is ScannerId {
    return Object.prototype.hasOwnProperty.call(SCANNER_CATALOG, value);
}

export function scannerDisplayName(source: string | null | undefined): string {
    return source && isScannerId(source) ? SCANNER_CATALOG[source].displayName : "The scanner";
}

export function isRescanCheck(check: string): boolean {
    return Object.values(SCANNER_CATALOG).some(s => s.rescanCheck === check);
}
