import type { ScanOutcome } from '../semgrep';

export type { ScanOutcome };

/**
 * One scanning tool, as the runner sees it.
 *
 * Contract for scan():
 *  - Resolve ok only for a scan that fully completed. Timeouts, crashes, malformed output and
 *    tool-level errors are failures; a failed scan must never look like "zero findings".
 *  - Every reported path is repository-relative (see toRepoRelativePath) and inside workDir.
 *  - Every finding carries the real source text of its lines, read from workDir.
 *  - `result` is the tool's own output shape. The app-side adapter with the same id
 *    (src/modules/scanners) validates and normalizes it.
 */
export interface ScanOptions {
    /**
     * Repository-relative files the job is about: the files a pull request changes, or the files
     * a proposed fix edits. A scanner may limit itself to them or scan the whole tree; either
     * way, both scans being compared (head and base, or before and after a fix) get the same list.
     */
    files?: string[];
}

export interface RunnerScanner {
    /** Same id as the app-side adapter: a FindingSource value such as "SEMGREP" */
    id: string;
    scan(workDir: string, options?: ScanOptions): Promise<ScanOutcome>;
}
