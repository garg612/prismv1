/**
 * Quality numbers for one account: how often shown issues were false alarms, and how often
 * suggested fixes were accepted. Pure: no I/O. Every number is a count of stored rows, and a
 * rate is only given when enough rows stand behind it.
 */

import { LOGIC_REVIEW_SOURCE } from "@/modules/logic-review/lib/schema";

/** A rate over fewer decisions than this is reported as "not enough data", never as a percentage. */
export const MIN_SAMPLE = 5;

export type Verdict = "REAL" | "FALSE_ALARM";

export interface MetricFeedback {
    kind: string;
    createdAt: Date | string;
}

export interface MetricFix {
    id: string;
    status: string;
    updatedAt: Date | string;
}

export interface MetricFinding {
    id: string;
    pullRequestId: string;
    source: string;
    ruleId: string;
    fingerprint: string;
    occurrence: number;
    triageDecision: string | null;
    createdAt: Date | string;
    feedback: MetricFeedback[];
    fixes: MetricFix[];
}

export interface Rate {
    /** Decisions counted in favour (false alarms, or accepted fixes) */
    count: number;
    /** All decisions counted */
    of: number;
    /** count / of, or null when `of` is below MIN_SAMPLE */
    value: number | null;
}

export interface WeekPoint {
    /** ISO date of the Monday that starts the week (UTC) */
    weekStart: string;
    shown: number;
    /** Not shown: triage judged these to be noise */
    filtered: number;
    accepted: number;
    rejected: number;
}

export interface FunnelStage {
    key: "found" | "shown" | "validated" | "applied";
    label: string;
    count: number;
    /** Why this stage is smaller than the one above it, from the same rows. Empty for the first stage. */
    note: string;
}

export interface Metrics {
    /** Distinct issues: the same issue re-detected on a later commit of the same pull request counts once */
    issues: {
        total: number;
        shown: number;
        /** Judged by triage to be noise, so not shown */
        filtered: number;
        /** Found by a review that stopped before triage */
        untriaged: number;
    };
    /** Shown scanner issues that were judged, and how many of those were false alarms */
    falseAlarms: Rate & { real: number; unjudged: number };
    fixes: Rate & { rejected: number; waiting: number; validated: number };
    funnel: FunnelStage[];
    weeks: WeekPoint[];
}

const time = (d: Date | string) => new Date(d).getTime();

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 a, 1 b" from the parts that are not zero; `whenNone` when every part is zero. */
const reasons = (parts: Array<[number, string]>, whenNone: string) => {
    const kept = parts.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`);
    return kept.length > 0 ? `${kept.join(", ")}.` : whenNone;
};

const rate = (count: number, of: number): Rate => ({ count, of, value: of >= MIN_SAMPLE ? count / of : null });

/**
 * What the account decided about an issue. The latest explicit answer wins. Without one,
 * applying the suggested fix counts as "real": nobody applies a fix for an issue they
 * consider a false alarm. Rejecting a fix says nothing about the issue itself.
 */
export function verdictOf(feedback: MetricFeedback[], fixes: Array<{ status: string }>): Verdict | null {
    const explicit = feedback
        .filter(f => f.kind === "TRUE_POSITIVE" || f.kind === "FALSE_POSITIVE")
        .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
    if (explicit) return explicit.kind === "FALSE_POSITIVE" ? "FALSE_ALARM" : "REAL";
    if (fixes.some(f => f.status === "IMPLEMENTED") || feedback.some(f => f.kind === "FIX_ACCEPTED")) return "REAL";
    return null;
}

/** The user's own latest "real / false alarm" answer, ignoring anything inferred from fixes. */
export function explicitVerdictOf(feedback: MetricFeedback[]): Verdict | null {
    return verdictOf(feedback.filter(f => f.kind === "TRUE_POSITIVE" || f.kind === "FALSE_POSITIVE"), []);
}

interface Issue {
    source: string;
    ruleId: string;
    triageDecision: string | null;
    firstSeen: number;
    lastSeen: number;
    /** When the review that set triageDecision ran */
    triagedAt: number;
    feedback: MetricFeedback[];
    fixes: Map<string, MetricFix>;
}

/** The same issue is stored once per review of a pull request. Fold those rows into one issue. */
export function distinctIssues(findings: MetricFinding[]): Issue[] {
    const issues = new Map<string, Issue>();
    for (const f of findings) {
        const key = `${f.pullRequestId}\u0000${f.source}\u0000${f.fingerprint}\u0000${f.occurrence}`;
        const seen = time(f.createdAt);
        let issue = issues.get(key);
        if (!issue) {
            issue = { source: f.source, ruleId: f.ruleId, triageDecision: null, firstSeen: seen, lastSeen: seen, triagedAt: 0, feedback: [], fixes: new Map() };
            issues.set(key, issue);
        }
        // The newest review that got as far as triage decides how the issue is classified. A later
        // review that was replaced or failed before triage does not erase that decision.
        if (f.triageDecision && (seen >= issue.triagedAt || !issue.triageDecision)) {
            issue.triagedAt = seen;
            issue.triageDecision = f.triageDecision;
        }
        issue.lastSeen = Math.max(issue.lastSeen, seen);
        issue.firstSeen = Math.min(issue.firstSeen, seen);
        issue.feedback.push(...f.feedback);
        for (const fix of f.fixes) issue.fixes.set(fix.id, fix);
    }
    return Array.from(issues.values());
}

/** Monday 00:00 UTC of the week containing `ms` */
export function weekStart(ms: number): number {
    const d = new Date(ms);
    const day = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const VALIDATED_FIX = ["READY", "IMPLEMENTING", "IMPLEMENTED", "IMPLEMENT_FAILED", "REJECTED", "STALE", "EXPIRED"];

export function buildMetrics(findings: MetricFinding[], range: { from: Date; to: Date }): Metrics {
    // AI logic suggestions are optional reading for the author. They are not tracked: nothing
    // about them is counted here.
    const all = distinctIssues(findings.filter(f => f.source !== LOGIC_REVIEW_SOURCE));
    const scanner = all;

    const shown = scanner.filter(i => i.triageDecision === "SURFACE");
    // Triage has two "not shown" outcomes (a clear "noise" and a low score that did not reach the
    // bar for showing). Both mean the same to the reader: filtered out as noise.
    const filtered = scanner.filter(i => i.triageDecision === "SUPPRESS" || i.triageDecision === "UNCERTAIN");
    const untriaged = scanner.length - shown.length - filtered.length;

    const verdicts = new Map<Issue, Verdict | null>(all.map(i => [i, verdictOf(i.feedback, Array.from(i.fixes.values()))]));
    const count = (list: Issue[], v: Verdict) => list.filter(i => verdicts.get(i) === v).length;
    void plural;

    const shownReal = count(shown, "REAL");
    const shownFalse = count(shown, "FALSE_ALARM");

    const fixes = scanner.flatMap(i => Array.from(i.fixes.values()));
    const accepted = fixes.filter(f => f.status === "IMPLEMENTED");
    const rejected = fixes.filter(f => f.status === "REJECTED");
    const waiting = fixes.filter(f => f.status === "READY" || f.status === "IMPLEMENT_FAILED");
    const validatedIssues = shown.filter(i => Array.from(i.fixes.values()).some(f => VALIDATED_FIX.includes(f.status)));
    const appliedIssues = shown.filter(i => Array.from(i.fixes.values()).some(f => f.status === "IMPLEMENTED"));

    // Why each stage is smaller than the one before it
    const notValidated = shown.filter(i => !validatedIssues.includes(i));
    const fixFailed = notValidated.filter(i => i.fixes.size > 0).length;
    const notApplied = validatedIssues.filter(i => !appliedIssues.includes(i));
    const has = (i: Issue, ...statuses: string[]) => Array.from(i.fixes.values()).some(f => statuses.includes(f.status));
    const waitingIssues = notApplied.filter(i => has(i, "READY", "IMPLEMENT_FAILED", "IMPLEMENTING")).length;
    const rejectedIssues = notApplied.filter(i => !has(i, "READY", "IMPLEMENT_FAILED", "IMPLEMENTING") && has(i, "REJECTED")).length;

    // Weekly series: issues by the week they were first found, fix decisions by the week they were made.
    const first = weekStart(range.from.getTime());
    const last = weekStart(range.to.getTime());
    const weeks = new Map<number, WeekPoint>();
    for (let w = first; w <= last; w += WEEK_MS) {
        weeks.set(w, { weekStart: new Date(w).toISOString().slice(0, 10), shown: 0, filtered: 0, accepted: 0, rejected: 0 });
    }
    const bucket = (ms: number) => weeks.get(weekStart(ms));
    for (const i of scanner) {
        const w = bucket(i.firstSeen);
        if (!w) continue;
        if (i.triageDecision === "SURFACE") w.shown++;
        else if (i.triageDecision === "SUPPRESS" || i.triageDecision === "UNCERTAIN") w.filtered++;
    }
    for (const f of accepted) { const w = bucket(time(f.updatedAt)); if (w) w.accepted++; }
    for (const f of rejected) { const w = bucket(time(f.updatedAt)); if (w) w.rejected++; }

    return {
        issues: { total: scanner.length, shown: shown.length, filtered: filtered.length, untriaged },
        falseAlarms: { ...rate(shownFalse, shownFalse + shownReal), real: shownReal, unjudged: shown.length - shownFalse - shownReal },
        fixes: { ...rate(accepted.length, accepted.length + rejected.length), rejected: rejected.length, waiting: waiting.length, validated: validatedIssues.length },
        funnel: [
            { key: "found", label: "Found by scanners", count: scanner.length, note: "" },
            {
                key: "shown", label: "Shown to you", count: shown.length,
                note: reasons([
                    [filtered.length, "filtered out as noise by triage, so you were not asked to look at them"],
                    [untriaged, `found by ${untriaged === 1 ? "a review" : "reviews"} that stopped before triage`],
                ], "Every issue found was shown."),
            },
            {
                key: "validated", label: "Got a validated fix", count: validatedIssues.length,
                note: reasons([
                    [fixFailed, `had a fix generated that did not pass validation, so it was never offered`],
                    [notValidated.length - fixFailed, `had no fix generated (fixes are generated for a limited number of issues per review)`],
                ], "Every shown issue got a fix that passed validation."),
            },
            {
                key: "applied", label: "Fix applied", count: appliedIssues.length,
                note: reasons([
                    [waitingIssues, `${waitingIssues === 1 ? "is" : "are"} waiting for your decision`],
                    [rejectedIssues, `${rejectedIssues === 1 ? "was" : "were"} rejected by you`],
                    [notApplied.length - waitingIssues - rejectedIssues, "went out of date before a decision"],
                ], "Every validated fix was applied."),
            },
        ],
        weeks: Array.from(weeks.values()),
    };
}

/**
 * False-alarm rate per rule, as fed to the triage model. Null when fewer than MIN_SAMPLE issues
 * of that rule have been judged: a rate from one or two answers would swing the model.
 */
export function ruleFalseAlarmRates(findings: MetricFinding[], ruleIds: string[]): Map<string, number | null> {
    const counts = new Map<string, { real: number; falseAlarm: number }>(ruleIds.map(id => [id, { real: 0, falseAlarm: 0 }]));
    for (const issue of distinctIssues(findings.filter(f => f.source !== LOGIC_REVIEW_SOURCE))) {
        const c = counts.get(issue.ruleId);
        if (!c) continue;
        const v = verdictOf(issue.feedback, Array.from(issue.fixes.values()));
        if (v === "REAL") c.real++;
        if (v === "FALSE_ALARM") c.falseAlarm++;
    }
    return new Map(ruleIds.map(id => {
        const c = counts.get(id)!;
        return [id, rate(c.falseAlarm, c.falseAlarm + c.real).value];
    }));
}
