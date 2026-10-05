/**
 * Which shown findings of one review get a fix.
 *
 * Every shown finding gets one, so a pull request is fixed in a single review rather than a few
 * findings at a time. The limit only protects against a pull request with an extreme number of
 * findings; the load on the fix model and the runner is balanced by the concurrency of the
 * process-finding function, not by leaving findings without a fix.
 */

export const DEFAULT_MAX_FIXES_PER_RUN = 25;

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

interface FixCandidate {
    id: string;
    source: string;
    severity: string;
    filePath: string;
    startLine: number;
}

export function maxFixesPerRun(raw: string | undefined = process.env.FIX_MAX_PER_RUN): number {
    const parsed = parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FIXES_PER_RUN;
}

/**
 * The findings to fix, most severe first. The order is fixed (severity, file, line, id) so that
 * when the limit does apply, the same findings are chosen every time. AI suggestions (source
 * CUSTOM) are never fixed.
 */
export function selectFindingsForFix<T extends FixCandidate>(findings: T[], max: number = maxFixesPerRun()): T[] {
    return findings
        .filter(f => f.source !== "CUSTOM")
        .sort((a, b) =>
            (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5)
            || a.filePath.localeCompare(b.filePath)
            || a.startLine - b.startLine
            || a.id.localeCompare(b.id))
        .slice(0, max);
}
