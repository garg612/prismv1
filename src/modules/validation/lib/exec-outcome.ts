export interface ExecCheckResult {
    status: string;
    duration?: number;
    log?: string;
    error?: string;
}

export interface ExecResultsPayload {
    provider?: string;
    baseline?: Record<string, ExecCheckResult>;
    fixed?: Record<string, ExecCheckResult>;
    /** Set by the runner instead of baseline/fixed when the repository has nothing it can run */
    notApplicable?: { code?: unknown; detail?: unknown };
}

export type ExecOutcome =
    | { outcome: 'FIXED' }
    | { outcome: 'VALIDATION_FAILED'; reason: string }
    | { outcome: 'INCONCLUSIVE'; reason: string }
    | { outcome: 'UNVERIFIED'; reason: string }
    /** Nothing in the repository can be executed. Static validation stands on its own. */
    | { outcome: 'NOT_APPLICABLE'; code: NotApplicableCode; reason: string };

export const EXEC_CHECKS = ["INSTALL", "LINT", "BUILD", "TEST"] as const;
/** Checks that exercise the repository's own code. INSTALL alone proves nothing about a fix. */
const EVIDENCE_CHECKS = ["LINT", "BUILD", "TEST"];
const REAL_PROVIDER = 'e2b';

/**
 * The only reasons execution validation may be skipped in favour of static validation.
 * Each one is a property of the repository at that commit, decided before a sandbox starts.
 * The wording is fixed here; the runner's own text is never shown to users.
 */
export const NOT_APPLICABLE_REASONS = {
    NO_PACKAGE_JSON: "this repository has no package.json, so there is no test, build or lint command to run",
    NO_LOCKFILE: "this repository has no package-lock.json, so its dependencies cannot be installed reproducibly",
    INVALID_PACKAGE_JSON: "this repository's package.json could not be read",
    NO_SCRIPTS: "package.json defines no test, build or lint script",
    ONLY_UNSAFE_SCRIPTS: "the test, build and lint scripts use shell features PRism does not run (such as && or pipes)",
} as const;

export type NotApplicableCode = keyof typeof NOT_APPLICABLE_REASONS;

function isNotApplicableCode(code: unknown): code is NotApplicableCode {
    return typeof code === 'string' && Object.prototype.hasOwnProperty.call(NOT_APPLICABLE_REASONS, code);
}

/** Summary stored on the skipped checks, and what the review page shows. */
export function notApplicableSummary(code: NotApplicableCode): string {
    return `Tests were not run: ${NOT_APPLICABLE_REASONS[code]}.`;
}

/**
 * Decide what execution validation proved.
 *
 *  - FIXED: a real sandbox ran at least one of lint/build/test and it passed both before and
 *    after the fix, with no regressions.
 *  - NOT_APPLICABLE: the runner reported, with a known code, that the repository has nothing to
 *    run. The caller keeps the static result.
 *  - Everything else (no results, unknown provider, unknown not-applicable code, nothing ran for
 *    any other reason) is UNVERIFIED, never a pass.
 */
export function decideExecutionOutcome(execResults: ExecResultsPayload | null | undefined): ExecOutcome {
    if (execResults?.notApplicable) {
        const code = execResults.notApplicable.code;
        // A not-applicable claim next to real results is contradictory; trust neither.
        if (execResults.baseline || execResults.fixed) {
            return { outcome: 'UNVERIFIED', reason: 'Execution validation reported both results and "nothing to run"' };
        }
        if (!isNotApplicableCode(code)) {
            return { outcome: 'UNVERIFIED', reason: 'Execution validation was skipped for an unrecognised reason' };
        }
        return { outcome: 'NOT_APPLICABLE', code, reason: notApplicableSummary(code) };
    }

    if (!execResults || !execResults.baseline || !execResults.fixed) {
        return { outcome: 'UNVERIFIED', reason: 'Execution validation produced no results' };
    }
    if (execResults.provider !== REAL_PROVIDER) {
        return { outcome: 'UNVERIFIED', reason: `Execution results did not come from a real sandbox (provider: ${execResults.provider ?? 'unknown'})` };
    }

    let regression: string | null = null;
    let inconclusive: string | null = null;
    let evidence = false;

    for (const check of EXEC_CHECKS) {
        const b = execResults.baseline[check]?.status ?? 'UNAVAILABLE';
        const f = execResults.fixed[check]?.status ?? 'UNAVAILABLE';
        const notRun = (s: string) => s === 'UNAVAILABLE' || s === 'UNVERIFIABLE' || s === 'SKIPPED';

        if (b === 'PASSED' && f === 'PASSED') {
            if (EVIDENCE_CHECKS.includes(check)) evidence = true;
        } else if (b === 'PASSED') {
            regression = regression ?? `Regression in ${check}`;
        } else if (notRun(b) || notRun(f)) {
            continue;
        } else {
            // Baseline was already failing: the fix cannot be judged against it.
            inconclusive = inconclusive ?? `${check} was not passing before the fix`;
        }
    }

    if (regression) return { outcome: 'VALIDATION_FAILED', reason: regression };
    if (inconclusive) return { outcome: 'INCONCLUSIVE', reason: inconclusive };
    if (!evidence) return { outcome: 'UNVERIFIED', reason: 'No lint, build or test check ran and passed in the sandbox' };
    return { outcome: 'FIXED' };
}
