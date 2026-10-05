import { eslintScanner } from './eslint';
import { semgrepScanner } from './semgrep';
import type { RunnerScanner } from './types';

export type { RunnerScanner };

/** Every scanner this runner can execute, by id. Register a new tool here. */
const SCANNERS: Record<string, RunnerScanner> = {
    [semgrepScanner.id]: semgrepScanner,
    [eslintScanner.id]: eslintScanner,
};

/** Returns undefined for a tool this runner does not have; the job then fails, it is not skipped. */
export function getScanner(tool: string): RunnerScanner | undefined {
    return Object.prototype.hasOwnProperty.call(SCANNERS, tool) ? SCANNERS[tool] : undefined;
}

export function listScannerIds(): string[] {
    return Object.keys(SCANNERS);
}

/** The neutral key the re-scan is reported under in STATIC_VALIDATE check results. */
export const RESCAN_CHECK = 'RESCAN';
