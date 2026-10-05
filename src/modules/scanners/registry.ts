import { isScannerId, ScannerId } from "./catalog";
import { eslintScanner } from "./eslint/adapter";
import { semgrepScanner } from "./semgrep/adapter";
import type { ScannerAdapter } from "./types";

const REGISTRY: Record<ScannerId, ScannerAdapter> = {
    SEMGREP: semgrepScanner,
    ESLINT: eslintScanner,
};

export class ScannerConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScannerConfigError";
    }
}

export function getScanner(id: string): ScannerAdapter {
    if (!isScannerId(id)) throw new ScannerConfigError(`No scanner is registered for "${id}"`);
    return REGISTRY[id];
}

/**
 * Scanners that run on every review, from PRISM_SCANNERS (comma-separated ids, default SEMGREP).
 * An unknown id is a configuration error, never silently skipped: a scanner that was asked for
 * and did not run would look like a clean result.
 */
export function getEnabledScanners(raw: string | undefined = process.env.PRISM_SCANNERS): ScannerAdapter[] {
    const ids = (raw ?? "SEMGREP").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (ids.length === 0) throw new ScannerConfigError("PRISM_SCANNERS is set but lists no scanner");
    return Array.from(new Set(ids)).map(getScanner);
}
