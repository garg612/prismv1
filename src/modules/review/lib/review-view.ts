/**
 * Turns the database records of a review run into what the review page says.
 * Pure: no I/O, no React. Every label on the page is decided here so that the
 * progress strip, the finding cards and the header can never disagree.
 */

import { isRescanCheck, scannerDisplayName } from "@/modules/scanners/catalog";
import { LOGIC_REVIEW_SOURCE } from "@/modules/logic-review/lib/schema";
import { explicitVerdictOf, Verdict } from "@/modules/metrics/lib/metrics";

export type Tone = "success" | "danger" | "warning" | "info" | "neutral";
export type StepState = "done" | "active" | "waiting" | "failed" | "skipped" | "todo";

export interface StepView {
    key: "scan" | "triage" | "fix" | "decision" | "recheck" | "found" | "applied" | "rescan" | "verified" | "result";
    label: string;
    state: StepState;
    detail: string;
}

export interface CheckView {
    label: string;
    state: "passed" | "failed" | "notRun";
    detail?: string;
}

export interface DiffLine {
    kind: "add" | "del" | "hunk" | "ctx";
    text: string;
}

export interface AppliedView {
    summary: string;
    linkUrl?: string;
    linkLabel?: string;
}

export interface FixView {
    id: string;
    status: string;
    statusLabel: string;
    tone: Tone;
    explanation: string | null;
    /** Why this fix is not usable, when it is not */
    problem: string | null;
    filePath: string | null;
    diff: DiffLine[];
    linesAdded: number;
    linesRemoved: number;
    checks: CheckView[];
    /** One sentence about test/build execution; null when execution checks are listed in `checks` */
    executionNote: string | null;
    applied: AppliedView | null;
    canDecide: boolean;
    /** Shown instead of the buttons when a READY fix can no longer be applied from this page */
    decisionBlockedReason: string | null;
}

export interface FindingView {
    id: string;
    title: string;
    ruleId: string;
    location: string;
    severity: string;
    severityTone: Tone;
    originLabel: string;
    /** Display name of the scanner that reported it */
    scanner: string;
    snippet: string | null;
    /** Line number of the first snippet line */
    line: number;
    reason: string;
    /** True when triage decided to show the issue; false when it was filtered out as noise */
    isShown: boolean;
    /** PRism's risk score for the issue, 0 to 100, and the score from which issues are shown. Null without a score. */
    triage: { score: number; showFrom: number } | null;
    fix: FixView | null;
    /** Earlier attempts that produced nothing usable */
    failedAttempts: Array<{ id: string; reason: string }>;
    canUnsuppress: boolean;
    /** What the signed-in user already answered to "is this a real issue?" */
    myVerdict: Verdict | null;
}

/** One possible bug suggested by the AI logic review */
export interface LogicIssueView {
    id: string;
    title: string;
    location: string;
    severity: string;
    severityTone: Tone;
    snippet: string | null;
    line: number;
    explanation: string;
    suggestion: string | null;
    /** Kind of bug, in words: "Off by one", "Wrong condition" */
    category: string;
}

export interface LogicReviewView {
    /** done: completed (with or without issues). failed: no result. running: still working. */
    state: "done" | "failed" | "running";
    summary: string;
    issues: LogicIssueView[];
}

export interface ReviewView {
    /** `technical` is the stored failure text, for whoever has to debug a review that did not complete */
    headline: { label: string; tone: Tone; detail: string; technical?: string };
    /** Counts shown under the headline. Each is a count of the cards on this page. */
    stats: Array<{ key: string; label: string; value: number; tone: Tone }>;
    /** How long the review took, in milliseconds. Null while it runs or when the start was not recorded. */
    durationMs: number | null;
    /** Set on a re-check: the earlier review of this pull request whose fixes this review confirms */
    earlierReview: { runId: string; headSha: string } | null;
    /** Set when a newer commit of this PR has its own review */
    newerReview: { runId: string; headSha: string } | null;
    steps: StepView[];
    shown: FindingView[];
    /** Issues triage judged to be noise, so they are not shown by default */
    filtered: FindingView[];
    /** AI logic review of the diff. Null when it was not requested for this review. */
    logicReview: LogicReviewView | null;
    /** True while something is still changing server-side, so the page should refresh itself */
    live: boolean;
}

/** An earlier review of the same pull request, replaced by the review being shown */
export interface EarlierRunInput {
    id: string;
    headSha: string;
    updatedAt: Date | string;
    findings: Array<{
        source: string;
        fingerprint: string;
        triageDecision: string | null;
        fixes: Array<{ status: string; applyAttempts?: Array<{ status: string; mode?: string; resultPrUrl?: string | null }> }>;
    }>;
}

/** The newest review of the same PR, when this run has been superseded */
export interface LatestRunInput {
    id: string;
    status: string;
    headSha: string;
    findings: Array<{ fingerprint: string }>;
}

/**
 * A review that is still marked as running but has not changed for this long will not finish:
 * its pipeline is gone. It is shown as not completed instead of "in progress" forever.
 */
export const STALLED_AFTER_MS = 60 * 60 * 1000;
const STALLED_MESSAGE = "This review stopped making progress and never finished, so this commit has no result. Push a new commit to have the pull request reviewed again.";

export function isStalled(run: { status: string; updatedAt?: Date | string | null }, now: number): boolean {
    if (!IN_PROGRESS_RUN.includes(run.status) || !run.updatedAt) return false;
    return now - new Date(run.updatedAt).getTime() > STALLED_AFTER_MS;
}

const IN_PROGRESS_RUN = ["QUEUED", "SCANNING", "CLASSIFYING", "FIXING", "VALIDATING", "REPORTING"];
const FAILED_RUN = ["FAILED", "CANCELED", "EXPIRED"];
/** A fix in one of these states passed validation at some point */
const VALIDATED_FIX = ["READY", "IMPLEMENTING", "IMPLEMENTED", "IMPLEMENT_FAILED", "REJECTED", "STALE", "EXPIRED"];
const WORKING_FIX = ["PENDING", "GENERATING", "GENERATED", "VALIDATING"];
const FIX_RANK = ["IMPLEMENTED", "IMPLEMENTING", "READY", "STALE", "REJECTED", "IMPLEMENT_FAILED", "EXPIRED", "VALIDATING", "GENERATED", "GENERATING", "PENDING", "NOT_READY", "GUARD_REJECTED"];

const short = (sha: string | null | undefined) => (sha ? sha.substring(0, 7) : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ─── Diff ─────────────────────────────────────────────────────────────────────

/** Drop the "Index:" / "====" / file header noise and classify the remaining lines. */
export function parseUnifiedDiff(unifiedDiff: string | null | undefined): DiffLine[] {
    if (!unifiedDiff) return [];
    const lines: DiffLine[] = [];
    for (const raw of unifiedDiff.replace(/\r\n/g, "\n").split("\n")) {
        if (raw.startsWith("Index: ") || /^=+$/.test(raw) || raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
        if (raw.startsWith("\\ No newline")) continue;
        if (raw.startsWith("@@")) lines.push({ kind: "hunk", text: raw });
        else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw });
        else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw });
        else lines.push({ kind: "ctx", text: raw });
    }
    while (lines.length > 0 && lines[lines.length - 1].text.trim() === "") lines.pop();
    return lines;
}

// ─── Triage ───────────────────────────────────────────────────────────────────

function describeTriage(finding: any): { reason: string; triage: FindingView["triage"] } {
    const classifications: any[] = [...(finding.classifications || [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    // The record that actually routed the finding, and the record holding a real model score (may be the same one)
    const routing = classifications.find(c => !c.isShadow) ?? classifications[0];
    const model = classifications.find(c => c.modelName && !String(c.modelName).startsWith("policy"));
    const decision: string | undefined = finding.triageDecision ?? routing?.finalDecision;
    const shown = decision === "SURFACE";
    const kind = `${String(finding.severity).toLowerCase()}-severity ${String(finding.category || "other").toLowerCase().replace("_", " ")}`;

    // The score is only put on the page when it is what decided the outcome, and agrees with it.
    // An issue shown by a rule (say, high-severity security) may carry a low score; showing that
    // score under "why you are seeing this" would contradict the sentence next to it.
    const score = model ? Math.round(Number(model.score) * 100) : null;
    const showFrom = model?.thresholdHigh != null ? Math.round(Number(model.thresholdHigh) * 100) : null;
    const decidedByScore = routing?.decisionSource === "MODEL" && score !== null && showFrom !== null && (score >= showFrom) === shown;
    const triage = decidedByScore ? { score: score as number, showFrom: showFrom as number } : null;

    let reason: string;
    switch (routing?.decisionSource) {
        case "POLICY_SEVERITY_FLOOR":
            reason = "Shown because it is a high-severity security issue. PRism always shows these, whatever their risk score.";
            break;
        case "MODEL":
            reason = shown
                ? "Shown because PRism rated it as likely to be a real problem."
                : "Filtered out as noise: PRism rated it as unlikely to be a real problem.";
            break;
        case "POLICY_FALLBACK":
            reason = `${shown ? "Shown" : "Filtered out as noise"} by PRism's standard rules for ${kind} issues. No risk score was available for this one.`;
            break;
        case "POLICY":
            reason = `${shown ? "Shown" : "Filtered out as noise"} by PRism's standard rules for ${kind} issues.`;
            break;
        case "OVERRIDE":
            reason = "Shown because you chose to bring it back.";
            break;
        default:
            reason = decision ? "" : "Not triaged yet.";
    }

    return { reason, triage };
}

// ─── Fix ──────────────────────────────────────────────────────────────────────

const STATIC_CHECK_LABEL: Record<string, string> = {
    PATCH_APPLY: "Change applies cleanly",
    SYNTAX: "Code still parses",
};
const EXEC_CHECK_LABEL: Record<string, string> = { INSTALL: "Install", LINT: "Lint", BUILD: "Build", TEST: "Tests" };

/** "Semgrep", or "Semgrep and ESLint": the scanners that actually ran for this review. */
function scannersUsed(run: any): string {
    const names = Array.from(new Set<string>((run.scanRuns || []).filter((s: any) => s.source !== LOGIC_REVIEW_SOURCE).map((s: any) => scannerDisplayName(s.source))));
    if (names.length === 0) return "The scan";
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function buildChecks(fix: any, finding: any, executionEnabled: boolean): { checks: CheckView[]; executionNote: string | null } {
    const runs: any[] = fix.validationRuns || [];
    const staticRun = runs.find(r => r.tier === "STATIC");
    const checks: CheckView[] = [];

    if (staticRun) {
        const result = (name: string) => (staticRun.validationResults || []).find((r: any) => r.check === name);
        for (const name of ["PATCH_APPLY", "SYNTAX"]) {
            const r = result(name);
            if (r) checks.push({ label: STATIC_CHECK_LABEL[name], state: r.status === "PASSED" ? "passed" : "failed" });
        }

        const scannerName = scannerDisplayName(finding.source);
        const rescan = (staticRun.validationResults || []).find((r: any) => isRescanCheck(r.check));
        if (rescan) {
            const deltas: any[] = staticRun.findingDeltas || [];
            const added = deltas.filter(d => d.delta === "ADDED");
            const target = deltas.find(d => d.delta !== "ADDED" && d.ruleId === finding.ruleId);
            if (rescan.status !== "PASSED") {
                checks.push({ label: `Re-scan with ${scannerName}`, state: "failed", detail: "the re-scan did not complete" });
            } else {
                checks.push(
                    target?.delta === "REMOVED"
                        ? { label: `${scannerName} no longer reports this issue`, state: "passed" }
                        : { label: `${scannerName} no longer reports this issue`, state: "failed", detail: "still reported after the change" }
                );
                checks.push(
                    added.length === 0
                        ? { label: "No new issues introduced", state: "passed" }
                        : { label: "No new issues introduced", state: "failed", detail: `introduces ${added.map(d => d.ruleId).join(", ")}` }
                );
            }
        }
    }

    const baseline = runs.find(r => r.tier === "EXECUTION" && r.kind === "BASELINE");
    const fixed = runs.find(r => r.tier === "EXECUTION" && r.kind === "FIXED");
    if (!fixed) {
        return {
            checks,
            executionNote: executionEnabled
                ? "Tests were not run for this fix."
                : "Tests were not run: execution validation is turned off for this repository, so this fix was checked by static analysis only.",
        };
    }

    // Execution was requested but the repository has nothing to run: static validation stands.
    const fixedResults: any[] = fixed.validationResults || [];
    const skippedReason = fixedResults.length > 0 && fixedResults.every(r => r.status === "SKIPPED")
        ? fixedResults.find(r => r.summary)?.summary
        : null;
    if (fixed.status === "COMPLETED" && skippedReason) {
        return { checks, executionNote: `${skippedReason} This fix was checked by static analysis only.` };
    }

    // Execution was attempted but could not start (no sandbox, isolation not established...)
    const didNotRun = (fixed.validationResults || []).find((r: any) => String(r.summary || "").startsWith("Execution validation did not run"));
    if (fixed.status !== "COMPLETED" || didNotRun) {
        return { checks, executionNote: didNotRun?.summary || "Tests could not be run for this fix." };
    }

    for (const name of Object.keys(EXEC_CHECK_LABEL)) {
        const b = (baseline?.validationResults || []).find((r: any) => r.check === name)?.status;
        const f = (fixed.validationResults || []).find((r: any) => r.check === name)?.status;
        if (!b && !f) continue;
        const label = EXEC_CHECK_LABEL[name];
        if (b === "PASSED" && f === "PASSED") checks.push({ label, state: "passed", detail: "passes before and after the change" });
        else if (b === "PASSED") checks.push({ label, state: "failed", detail: "passed before the change, fails after it" });
        else if (b === "UNAVAILABLE" || f === "UNAVAILABLE" || !b || !f) checks.push({ label, state: "notRun", detail: "not available in this repository" });
        else checks.push({ label, state: "notRun", detail: "was already failing before the change, so it proves nothing" });
    }
    return { checks, executionNote: null };
}

const OUTCOME_PROBLEM: Record<string, string> = {
    VALIDATION_FAILED: "The proposed change failed validation.",
    NOT_FIXED: "The proposed change did not remove the issue.",
    PARTIALLY_FIXED: "The proposed change only partly removed the issue.",
    NEW_FINDING_INTRODUCED: "The proposed change introduced a new issue.",
    UNVERIFIED: "The proposed change could not be verified.",
};

/** Reduce a stored generation error to one short clause. The full text stays in the database. */
function generationFailureCause(explanation: string | null | undefined): string {
    const text = String(explanation || "");
    if (/quota|rate.?limit|429/i.test(text)) return ": the AI model's usage limit was reached.";
    if (/high demand|overloaded|503|unavailable|timed? ?out/i.test(text)) return ": the AI model was temporarily unavailable.";
    if (/API_KEY|not configured|unauthor|401|403/i.test(text)) return ": the AI model is not configured correctly.";
    if (/SOURCE_(UNAVAILABLE|MISMATCH)/.test(text)) return ": the source file could not be read at this commit.";
    return ".";
}

function fixProblem(fix: any): string | null {
    if (fix.status === "GUARD_REJECTED") return fix.explanation ? `Blocked by safety checks: ${fix.explanation}` : "Blocked by safety checks.";
    if (fix.status === "NOT_READY") {
        if (fix.outcome && OUTCOME_PROBLEM[fix.outcome]) return OUTCOME_PROBLEM[fix.outcome];
        return `No fix could be generated${generationFailureCause(fix.explanation)}`;
    }
    if (fix.status === "IMPLEMENT_FAILED") return "PRism could not apply this fix. Nothing was changed in the repository, so it can be applied again.";
    if (fix.status === "STALE") return "The pull request changed after this fix was validated, so it can no longer be applied.";
    if (fix.status === "EXPIRED") return "This fix expired before it was applied.";
    return null;
}

const FIX_STATUS: Record<string, { label: string; tone: Tone }> = {
    READY: { label: "Ready to apply", tone: "info" },
    IMPLEMENTING: { label: "Applying", tone: "info" },
    IMPLEMENTED: { label: "Applied", tone: "success" },
    REJECTED: { label: "Rejected", tone: "neutral" },
    STALE: { label: "Out of date", tone: "warning" },
    EXPIRED: { label: "Expired", tone: "neutral" },
    IMPLEMENT_FAILED: { label: "Could not apply", tone: "danger" },
    NOT_READY: { label: "No usable fix", tone: "warning" },
    GUARD_REJECTED: { label: "Blocked", tone: "warning" },
};

function describeApplied(fix: any, verified: boolean): AppliedView | null {
    const attempt = (fix.applyAttempts || []).find((a: any) => a.status === "SUCCEEDED");
    if (!attempt) return fix.status === "IMPLEMENTED" ? { summary: "Applied." } : null;

    const prNumber = attempt.resultPrUrl?.match(/\/pull\/(\d+)/)?.[1];
    if (attempt.mode === "FIX_BRANCH_PR") {
        return {
            summary: verified
                ? `Applied through a separate pull request${prNumber ? ` (#${prNumber})` : ""}, which has been merged into this PR's branch.`
                : `Opened as a separate pull request${prNumber ? ` (#${prNumber})` : ""} into this PR's branch. It takes effect once that pull request is merged.`,
            linkUrl: attempt.resultPrUrl || undefined,
            linkLabel: prNumber ? `Open fix PR #${prNumber}` : "Open fix PR",
        };
    }
    if (attempt.mode === "SUGGESTION_COMMENT") {
        return {
            summary: "Posted on the pull request as a suggested change. It is not applied until someone commits it.",
            linkUrl: attempt.resultPrUrl || undefined,
            linkLabel: "Open the comment",
        };
    }
    return { summary: `Committed to the pull request branch${attempt.resultCommitSha ? ` as ${short(attempt.resultCommitSha)}` : ""}.` };
}

function buildFix(fix: any, finding: any, run: any, verified: boolean, attempts: number): FixView {
    const working = WORKING_FIX.includes(fix.status);
    const status = FIX_STATUS[fix.status] ?? { label: working ? "Working on a fix" : fix.status, tone: "info" as Tone };
    const { checks, executionNote } = buildChecks(fix, finding, !!run.repository?.executionValidation);

    // A failed apply writes nothing to the repository, so the fix stays open for another attempt.
    const decidable = fix.status === "READY" || fix.status === "IMPLEMENT_FAILED";
    const canDecide = decidable && run.status === "AWAITING_APPROVAL";
    let decisionBlockedReason: string | null = null;
    if (decidable && !canDecide) {
        decisionBlockedReason = run.status === "SUPERSEDED"
            ? "This fix was validated against an older commit, so it can no longer be applied from here. Open the latest review instead."
            : "This fix cannot be applied until the review has finished.";
    }

    return {
        id: fix.id,
        status: fix.status,
        statusLabel: status.label,
        tone: status.tone,
        explanation: VALIDATED_FIX.includes(fix.status) || working ? fix.explanation || null : null,
        problem: withAttempts(fixProblem(fix), fix, attempts),
        filePath: fix.patch ? Object.keys(fix.patch.baseBlobShas || {})[0] ?? finding.filePath : null,
        diff: parseUnifiedDiff(fix.patch?.unifiedDiff),
        linesAdded: fix.patch?.linesAdded ?? 0,
        linesRemoved: fix.patch?.linesRemoved ?? 0,
        checks,
        executionNote: fix.patch ? executionNote : null,
        applied: describeApplied(fix, verified),
        canDecide,
        decisionBlockedReason,
    };
}

function withAttempts(problem: string | null, fix: any, attempts: number): string | null {
    if (!problem || attempts < 2 || (fix.status !== "NOT_READY" && fix.status !== "GUARD_REJECTED")) return problem;
    return `${problem} (${attempts} attempts)`;
}

function pickFixes(finding: any): { primary: any | null; failed: any[] } {
    const fixes: any[] = [...(finding.fixes || [])].sort((a, b) => {
        const rank = FIX_RANK.indexOf(a.status) - FIX_RANK.indexOf(b.status);
        return rank !== 0 ? rank : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const primary = fixes[0] ?? null;
    return { primary, failed: fixes.slice(1).filter(f => f.status === "NOT_READY" || f.status === "GUARD_REJECTED") };
}

// ─── Finding ──────────────────────────────────────────────────────────────────

const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: "danger", HIGH: "danger", MEDIUM: "warning", LOW: "neutral", INFO: "neutral" };

function buildFinding(finding: any, run: any, latestRun: LatestRunInput | null): FindingView {
    const triage = describeTriage(finding);
    const { primary, failed } = pickFixes(finding);
    const primaryUnusable = primary && (primary.status === "NOT_READY" || primary.status === "GUARD_REJECTED");
    const verified = !!latestRun
        && !IN_PROGRESS_RUN.includes(latestRun.status)
        && !FAILED_RUN.includes(latestRun.status)
        && !latestRun.findings.some(f => f.fingerprint === finding.fingerprint);
    return {
        id: finding.id,
        title: finding.message,
        ruleId: finding.ruleId,
        location: `${finding.filePath}:${finding.startLine}`,
        severity: finding.severity,
        severityTone: SEVERITY_TONE[finding.severity] ?? "neutral",
        originLabel: finding.isPreexisting ? "Already in the base branch" : "New in this PR",
        scanner: scannerDisplayName(finding.source),
        snippet: finding.codeSnippet || null,
        line: finding.startLine,
        reason: triage.reason,
        isShown: finding.triageDecision === "SURFACE",
        triage: triage.triage,
        fix: primary ? buildFix(primary, finding, run, verified, failed.length + 1) : null,
        failedAttempts: primaryUnusable ? [] : failed.map(f => ({ id: f.id, reason: fixProblem(f) || "No fix could be generated." })),
        // A filtered issue can only be brought back on the finished, current review of the pull request.
        canUnsuppress: (finding.triageDecision === "SUPPRESS" || finding.triageDecision === "UNCERTAIN") && (run.status === "AWAITING_APPROVAL" || run.status === "COMPLETED"),
        myVerdict: explicitVerdictOf(finding.feedback || []),
    };
}

// ─── Steps and headline ───────────────────────────────────────────────────────


function humanCategory(ruleId: string): string {
    const words = String(ruleId || "").replace(/^logic\//, "").replace(/-/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Logic";
}

function buildLogicReview(run: any, runInProgress: boolean): LogicReviewView | null {
    const scan = (run.scanRuns || []).find((s: any) => s.source === LOGIC_REVIEW_SOURCE);
    if (!scan) return null;

    const issues: LogicIssueView[] = (run.findings || [])
        .filter((f: any) => f.source === LOGIC_REVIEW_SOURCE)
        .map((f: any) => ({
            id: f.id,
            title: f.ruleName || "Possible logic bug",
            location: `${f.filePath}:${f.startLine}${f.endLine > f.startLine ? `-${f.endLine}` : ""}`,
            severity: f.severity,
            severityTone: SEVERITY_TONE[f.severity] ?? "neutral",
            snippet: f.codeSnippet || null,
            line: f.startLine,
            explanation: f.message,
            suggestion: (f.metadata as any)?.logicReview?.suggestion || null,
            category: humanCategory(f.ruleId),
        }));

    if (scan.status === "FAILED" || scan.status === "TIMEOUT") {
        return { state: "failed", summary: "The AI logic review did not complete for this commit, so it has no result. That is not the same as finding nothing.", issues: [] };
    }
    if (scan.status !== "COMPLETED") {
        return runInProgress
            ? { state: "running", summary: "Reviewing the changes for logic bugs.", issues: [] }
            : { state: "failed", summary: "The AI logic review did not finish for this commit, so it has no result.", issues: [] };
    }

    const reviewed = scan.scannedFiles ?? 0;
    const skipped = scan.skippedFiles ?? 0;
    const coverage = skipped > 0 ? ` ${plural(skipped, "large file")} could not be included and ${skipped === 1 ? "was" : "were"} not reviewed.` : "";
    if (reviewed === 0 && skipped === 0) {
        return { state: "done", summary: "This pull request changes no source code files, so there was nothing to review.", issues };
    }
    const summary = issues.length === 0
        ? `The AI read the ${plural(reviewed, "changed code file")} and has nothing to suggest.${coverage}`
        : `The AI read the ${plural(reviewed, "changed code file")} and has ${plural(issues.length, "suggestion")}.${coverage}`;
    return { state: "done", summary, issues };
}

export function buildReviewView(run: any, latestRun: LatestRunInput | null, now: number = Date.now(), earlierRuns: EarlierRunInput[] = []): ReviewView {
    // Scanner findings and the AI logic review are separate tracks. Everything below about triage,
    // fixes and re-checks concerns scanner findings only.
    const findings: any[] = (run.findings || []).filter((f: any) => f.source !== LOGIC_REVIEW_SOURCE);
    const surfaced = findings.filter(f => f.triageDecision === "SURFACE");
    // Triage has two outcomes that both mean "not shown": a clear noise verdict, and a low score
    // that did not reach the bar for showing. To the reader they are the same thing: noise.
    const suppressed = findings.filter(f => f.triageDecision === "SUPPRESS" || f.triageDecision === "UNCERTAIN");
    const stalled = isStalled(run, now);
    const runInProgress = IN_PROGRESS_RUN.includes(run.status) && !stalled;
    const runFailed = FAILED_RUN.includes(run.status) || stalled;
    const headSha = short(run.headSha);
    const logicReview = buildLogicReview(run, runInProgress);

    // 1. Scan
    const scans: any[] = (run.scanRuns || []).filter((s: any) => s.source !== LOGIC_REVIEW_SOURCE);
    const failedScan = scans.find(s => s.status === "FAILED" || s.status === "TIMEOUT");
    // With several scanners, the file count is that of the scanner that looked at the most files.
    const headScan = scans.filter(s => s.kind === "HEAD").sort((a, b) => (b.scannedFiles ?? 0) - (a.scannedFiles ?? 0))[0];
    const severalScanners = new Set(scans.map(s => s.source)).size > 1;
    const scansDone = scans.length >= 2 && scans.every(s => s.status === "COMPLETED");
    let scan: StepView;
    if (failedScan) {
        const code = (failedScan.toolErrors as any)?.code;
        scan = { key: "scan", label: "Scan", state: "failed", detail: `The ${severalScanners ? `${scannerDisplayName(failedScan.source)} ` : ""}${String(failedScan.kind).toLowerCase()} scan did not complete${code ? ` (${code})` : ""}` };
    } else if (scansDone) {
        scan = { key: "scan", label: "Scan", state: "done", detail: `${plural(headScan?.scannedFiles ?? 0, "file")} scanned, ${plural(findings.length, "issue")} found` };
    } else if (runFailed) {
        scan = { key: "scan", label: "Scan", state: "failed", detail: run.failureCode || "The review stopped before the scan finished" };
    } else {
        scan = { key: "scan", label: "Scan", state: "active", detail: "Scanning the pull request" };
    }

    // 2. Triage
    let triage: StepView;
    if (scan.state !== "done") triage = { key: "triage", label: "Triage", state: scan.state === "failed" ? "skipped" : "todo", detail: "" };
    else if (findings.length === 0) triage = { key: "triage", label: "Triage", state: "skipped", detail: "Nothing to triage" };
    else if (findings.every(f => f.triageDecision)) {
        const parts = [`${surfaced.length} shown`];
        if (suppressed.length) parts.push(`${suppressed.length} filtered as noise`);
        triage = { key: "triage", label: "Triage", state: "done", detail: parts.join(", ") };
    } else if (runFailed) triage = { key: "triage", label: "Triage", state: "failed", detail: run.failureCode || "Triage did not finish" };
    else triage = { key: "triage", label: "Triage", state: "active", detail: "Deciding which issues matter" };

    // 3. Fix
    const primaries = surfaced.map(f => pickFixes(f).primary);
    const validated = primaries.filter(f => f && VALIDATED_FIX.includes(f.status));
    const working = primaries.filter(f => f && WORKING_FIX.includes(f.status));
    const unusable = primaries.filter(f => f && (f.status === "NOT_READY" || f.status === "GUARD_REJECTED"));
    let fix: StepView;
    if (triage.state !== "done") {
        const waiting = triage.state === "todo" || triage.state === "active";
        fix = { key: "fix", label: "Fix", state: waiting ? "todo" : "skipped", detail: waiting ? "" : "Nothing to fix" };
    }
    else if (surfaced.length === 0) fix = { key: "fix", label: "Fix", state: "skipped", detail: "No issue needs a fix" };
    else if (working.length > 0 || (run.status === "FIXING" && validated.length + unusable.length < surfaced.length)) {
        fix = { key: "fix", label: "Fix", state: "active", detail: "Generating and validating a fix" };
    } else if (validated.length > 0) {
        fix = { key: "fix", label: "Fix", state: "done", detail: `${plural(validated.length, "fix", "fixes")} generated and validated${unusable.length ? `, ${unusable.length} could not be fixed` : ""}` };
    } else if (unusable.length > 0) {
        const neverGenerated = unusable.every(f => f.status === "NOT_READY" && !f.outcome);
        fix = { key: "fix", label: "Fix", state: "failed", detail: neverGenerated ? "No fix could be generated" : "No fix passed validation" };
    } else {
        fix = { key: "fix", label: "Fix", state: "skipped", detail: "No fix was generated" };
    }

    // 4. Your decision
    const ready = validated.filter(f => f.status === "READY" || f.status === "IMPLEMENT_FAILED");
    const applied = validated.filter(f => f.status === "IMPLEMENTED");
    const applying = validated.filter(f => f.status === "IMPLEMENTING");
    const rejected = validated.filter(f => f.status === "REJECTED");
    let decision: StepView;
    if (validated.length === 0) decision = { key: "decision", label: "Your decision", state: fix.state === "skipped" || fix.state === "failed" ? "skipped" : "todo", detail: fix.state === "skipped" || fix.state === "failed" ? "Nothing to decide" : "" };
    else if (applying.length > 0) decision = { key: "decision", label: "Your decision", state: "active", detail: "Applying the fix" };
    else if (ready.length > 0 && run.status === "AWAITING_APPROVAL") decision = { key: "decision", label: "Your decision", state: "waiting", detail: `${plural(ready.length, "fix", "fixes")} waiting for you` };
    else if (applied.length > 0 || rejected.length > 0) {
        const parts = [];
        if (applied.length) parts.push(`${applied.length} accepted`);
        if (rejected.length) parts.push(`${rejected.length} rejected`);
        decision = { key: "decision", label: "Your decision", state: "done", detail: parts.join(", ") };
    } else decision = { key: "decision", label: "Your decision", state: "skipped", detail: "The fix is no longer applicable" };

    // 5. Re-check: has a later scan confirmed the applied fix?
    let recheck: StepView;
    const appliedFindings = surfaced.filter(f => pickFixes(f).primary?.status === "IMPLEMENTED");
    if (appliedFindings.length === 0) {
        recheck = { key: "recheck", label: "Re-check", state: decision.state === "todo" || decision.state === "waiting" || decision.state === "active" ? "todo" : "skipped", detail: decision.state === "done" ? "No fix was applied" : decision.state === "skipped" ? "Not needed" : "" };
    } else if (!latestRun) {
        const attempt = (pickFixes(appliedFindings[0]).primary.applyAttempts || []).find((a: any) => a.status === "SUCCEEDED");
        const prNumber = attempt?.resultPrUrl?.match(/\/pull\/(\d+)/)?.[1];
        recheck = attempt?.mode === "FIX_BRANCH_PR"
            ? { key: "recheck", label: "Re-check", state: "waiting", detail: `Merge the fix PR${prNumber ? ` #${prNumber}` : ""}; the pull request is re-scanned after that` }
            : attempt?.mode === "SUGGESTION_COMMENT"
                ? { key: "recheck", label: "Re-check", state: "waiting", detail: "Commit the suggested change; the pull request is re-scanned after that" }
                : { key: "recheck", label: "Re-check", state: "active", detail: "Waiting for the re-scan of the new commit" };
    } else if (IN_PROGRESS_RUN.includes(latestRun.status)) {
        recheck = { key: "recheck", label: "Re-check", state: "active", detail: `Re-scanning commit ${short(latestRun.headSha)}` };
    } else if (FAILED_RUN.includes(latestRun.status)) {
        recheck = { key: "recheck", label: "Re-check", state: "failed", detail: `The re-scan of ${short(latestRun.headSha)} did not complete` };
    } else {
        const still = new Set(latestRun.findings.map(f => f.fingerprint));
        const remaining = appliedFindings.filter(f => still.has(f.fingerprint)).length;
        recheck = remaining === 0
            ? { key: "recheck", label: "Re-check", state: "done", detail: `Confirmed: no longer detected in ${short(latestRun.headSha)}` }
            : { key: "recheck", label: "Re-check", state: "failed", detail: `Still detected in ${short(latestRun.headSha)}` };
    }

    // Headline: the one thing the reader should take away
    let headline: ReviewView["headline"];
    if (runFailed) {
        headline = { label: "Analysis did not complete", tone: "danger", detail: stalled ? STALLED_MESSAGE
                : /stale/i.test(String(run.failureMessage || "")) ? "The pull request received a newer commit before this review finished, so this commit has no result."
                : "The review could not be completed, so this commit has no result. That is not the same as a clean result.",
            technical: stalled ? undefined : run.failureMessage || run.failureCode || undefined,
        };
    } else if (runInProgress) {
        headline = { label: "Analysis in progress", tone: "info", detail: `Reviewing commit ${headSha}.` };
    } else if (recheck.state === "done") {
        headline = { label: "Fixed and verified", tone: "success", detail: `The fix was applied and a re-scan of ${short(latestRun?.headSha)} no longer finds the issue.` };
    } else if (recheck.state === "failed") {
        headline = { label: "Not verified", tone: "danger", detail: `${recheck.detail}.` };
    } else if (run.status === "SUPERSEDED" && applied.length === 0) {
        headline = { label: "Replaced by a newer review", tone: "neutral", detail: `This review covers commit ${headSha}. The pull request has changed since.` };
    } else if (applying.length > 0) {
        headline = { label: "Applying the fix", tone: "info", detail: "The change is being sent to GitHub. This page updates by itself." };
    } else if (decision.state === "waiting") {
        headline = { label: "Needs your decision", tone: "warning", detail: `${plural(ready.length, "validated fix", "validated fixes")} ${ready.length === 1 ? "is" : "are"} waiting to be accepted or rejected.` };
    } else if (applied.length > 0) {
        headline = { label: "Fix applied, not yet verified", tone: "info", detail: `${recheck.detail}.` };
    } else if (surfaced.length === 0) {
        headline = findings.length === 0
            ? { label: "No issues found", tone: "success", detail: `${scannersUsed(run)} found nothing in commit ${headSha}.` }
            : { label: "Nothing needs your attention", tone: "success", detail: `${plural(findings.length, "issue")} found and filtered out as noise.` };
    } else if (rejected.length > 0 && rejected.length === validated.length) {
        headline = { label: "Fix rejected", tone: "neutral", detail: `${plural(surfaced.length, "issue")} remain${surfaced.length === 1 ? "s" : ""} in the pull request.` };
    } else {
        headline = { label: "Issues found, no automatic fix", tone: "warning", detail: `${plural(surfaced.length, "issue")} need${surfaced.length === 1 ? "s" : ""} a manual fix.` };
    }

    let stats: ReviewView["stats"] = [
        { key: "shown", label: surfaced.length === 1 ? "Issue to look at" : "Issues to look at", value: surfaced.length, tone: surfaced.length > 0 ? "danger" : "neutral" },
        { key: "waiting", label: ready.length === 1 ? "Fix waiting for you" : "Fixes waiting for you", value: run.status === "AWAITING_APPROVAL" ? ready.length : 0, tone: ready.length > 0 && run.status === "AWAITING_APPROVAL" ? "warning" : "neutral" },
        { key: "applied", label: applied.length === 1 ? "Fix applied" : "Fixes applied", value: applied.length, tone: applied.length > 0 ? "success" : "neutral" },
    ];
    stats.push({ key: "hidden", label: "Filtered as noise", value: suppressed.length, tone: "neutral" });

    const started = run.startedAt ? new Date(run.startedAt).getTime() : NaN;
    const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : NaN;
    const durationMs = !runInProgress && finished > started ? finished - started : null;

    let steps: StepView[] = [scan, triage, fix, decision, recheck];
    let earlierReview: ReviewView["earlierReview"] = null;

    // A re-check: an earlier review of this pull request found issues, their fixes were applied,
    // and this review scanned the result and has nothing left to act on. Its own Fix and Decision
    // stages are empty by nature, so the page tells the story of the pull request instead.
    const fixedEarlier = new Map<string, { run: EarlierRunInput; prNumber: string | null }>();
    for (const earlier of [...earlierRuns].sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())) {
        for (const f of earlier.findings) {
            if (f.source === LOGIC_REVIEW_SOURCE || f.triageDecision !== "SURFACE") continue;
            const appliedFix = f.fixes.find(x => x.status === "IMPLEMENTED");
            if (!appliedFix || fixedEarlier.has(f.fingerprint)) continue;
            const attempt = (appliedFix.applyAttempts || []).find(a => a.status === "SUCCEEDED");
            fixedEarlier.set(f.fingerprint, { run: earlier, prNumber: attempt?.resultPrUrl?.match(/\/pull\/(\d+)/)?.[1] ?? null });
        }
    }
    const isRecheck = fixedEarlier.size > 0 && surfaced.length === 0 && run.status !== "SUPERSEDED" && !runFailed;
    if (isRecheck) {
        const n = fixedEarlier.size;
        const source = Array.from(fixedEarlier.values())[0].run;
        const prNumbers = Array.from(new Set(Array.from(fixedEarlier.values()).map(v => v.prNumber).filter(Boolean)));
        const present = new Set(findings.map(f => f.fingerprint));
        const still = Array.from(fixedEarlier.keys()).filter(fp => present.has(fp)).length;
        earlierReview = { runId: source.id, headSha: short(source.headSha) };

        const verified: StepView = !scansDone
            ? { key: "verified", label: "Verified", state: "todo", detail: "" }
            : still === 0
                ? { key: "verified", label: "Verified", state: "done", detail: `No longer detected in ${headSha}` }
                : { key: "verified", label: "Verified", state: "failed", detail: `${plural(still, "issue")} still detected in ${headSha}` };
        steps = [
            { key: "found", label: n === 1 ? "Issue found" : "Issues found", state: "done", detail: `${plural(n, "issue")} in commit ${short(source.headSha)}` },
            { key: "applied", label: n === 1 ? "Fix applied" : "Fixes applied", state: "done", detail: prNumbers.length === 1 ? `Merged through fix PR #${prNumbers[0]}` : `${plural(n, "fix", "fixes")} applied` },
            { key: "rescan", label: "Re-scan", state: scansDone ? "done" : "active", detail: scansDone ? `${plural(headScan?.scannedFiles ?? 0, "file")} scanned in ${headSha}` : `Scanning commit ${headSha}` },
            verified,
        ];
        if (runInProgress) {
            headline = { label: "Re-checking after the fix", tone: "info", detail: `Scanning commit ${headSha} to confirm the applied ${n === 1 ? "fix" : "fixes"}.` };
        } else if (still === 0) {
            headline = { label: "Fixed and verified", tone: "success", detail: `${n === 1 ? "The fix" : `All ${n} fixes`} applied after the review of ${short(source.headSha)} ${n === 1 ? "is" : "are"} confirmed: a re-scan of ${headSha} no longer finds ${n === 1 ? "the issue" : "the issues"}.` };
        } else {
            headline = { label: "Not verified", tone: "danger", detail: `${plural(still, "issue")} that had a fix applied ${still === 1 ? "is" : "are"} still detected in ${headSha}.` };
        }
        stats = [
            { key: "found", label: n === 1 ? "Issue found" : "Issues found", value: n, tone: "neutral" },
            { key: "applied", label: n === 1 ? "Fix applied" : "Fixes applied", value: n, tone: "success" },
            { key: "still", label: "Still detected", value: still, tone: still > 0 ? "danger" : "neutral" },
            { key: "hidden", label: "Filtered as noise", value: suppressed.length, tone: "neutral" },
        ];
    } else if (!runInProgress && !runFailed) {
        // A finished review shows the stages that actually happened, then how it ended.
        const happened = steps.filter(s => s.state !== "skipped");
        if (happened.length < steps.length) {
            const resultState: StepState = headline.tone === "success" ? "done" : headline.tone === "danger" ? "failed" : headline.tone === "warning" ? "waiting" : "skipped";
            steps = [...happened, { key: "result", label: "Result", state: resultState, detail: headline.label }];
        }
    }

    return {
        headline,
        stats,
        durationMs,
        logicReview,
        earlierReview,
        newerReview: latestRun && latestRun.id !== run.id ? { runId: latestRun.id, headSha: short(latestRun.headSha) } : null,
        steps,
        shown: surfaced.map(f => buildFinding(f, run, latestRun)),
        filtered: suppressed.map(f => buildFinding(f, run, latestRun)),
        live: runInProgress || applying.length > 0 || recheck.state === "active" || logicReview?.state === "running",
    };
}
