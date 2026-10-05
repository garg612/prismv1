/**
 * The reviews list: one row per pull request. Pure: no I/O.
 *
 * A pull request is reviewed once per commit, and the newest review is usually a re-scan made
 * after a fix was applied, which by itself finds nothing. So a row does not describe the newest
 * review alone: it tells what happened on the pull request across all of its reviews (issues
 * found, fixes applied, what is still open). Every count comes from stored findings and fixes.
 *
 * AI logic suggestions are optional reading and are not part of any count or status here.
 */

import { LOGIC_REVIEW_SOURCE } from "@/modules/logic-review/lib/schema";
import { isStalled, Tone } from "./review-view";

export type ReviewListGroup = "decision" | "progress" | "issues" | "clean" | "failed";

export interface ReviewListRunInput {
    id: string;
    status: string;
    headSha: string;
    updatedAt: Date | string;
    pullRequest: { id: string; number: number; title: string; url: string };
    repository: { owner: string; name: string };
    findings: Array<{ source: string; fingerprint: string; occurrence: number; triageDecision: string | null; fixes: Array<{ status: string }> }>;
}

export interface ReviewListItem {
    /** The current review of the pull request: the row links to it */
    runId: string;
    repository: string;
    prNumber: number;
    prTitle: string;
    prUrl: string;
    headSha: string;
    updatedAt: string;
    label: string;
    tone: Tone;
    group: ReviewListGroup;
    counts: {
        /** Distinct issues shown on any review of the pull request */
        found: number;
        /** Of those, how many had a fix applied */
        fixed: number;
        /** Validated fixes waiting for a decision on the current review */
        toDecide: number;
        /** Issues still reported by the current review. Null while that review has no result. */
        open: number | null;
    };
    /** Older reviews of the same pull request, newest first */
    earlier: Array<{ runId: string; headSha: string; updatedAt: string; label: string }>;
}

const IN_PROGRESS = ["QUEUED", "SCANNING", "CLASSIFYING", "FIXING", "VALIDATING", "REPORTING"];
const FAILED = ["FAILED", "CANCELED", "EXPIRED"];

type Finding = ReviewListRunInput["findings"][number];

const shownFindings = (run: ReviewListRunInput): Finding[] =>
    run.findings.filter(f => f.source !== LOGIC_REVIEW_SOURCE && f.triageDecision === "SURFACE");
const issueKey = (f: Finding) => `${f.source}\u0000${f.fingerprint}\u0000${f.occurrence}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const iso = (d: Date | string) => new Date(d).toISOString();

/** One line for an older review: what that review itself found and did. */
function earlierLabel(run: ReviewListRunInput, now: number): string {
    if (FAILED.includes(run.status) || isStalled(run, now)) return "Did not complete";
    if (IN_PROGRESS.includes(run.status)) return "In progress";
    const shown = shownFindings(run);
    if (shown.length === 0) return "No issues";
    const applied = shown.filter(f => f.fixes.some(x => x.status === "IMPLEMENTED")).length;
    return `${plural(shown.length, "issue")} found${applied > 0 ? `, ${plural(applied, "fix", "fixes")} applied` : ""}`;
}

export function buildReviewList(runs: ReviewListRunInput[], now: number = Date.now()): ReviewListItem[] {
    const byPr = new Map<string, ReviewListRunInput[]>();
    for (const run of runs) {
        const list = byPr.get(run.pullRequest.id);
        if (list) list.push(run);
        else byPr.set(run.pullRequest.id, [run]);
    }

    const items: ReviewListItem[] = [];
    for (const list of byPr.values()) {
        list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        // The current review is the newest one that has not been replaced by a later commit.
        const current = list.find(r => r.status !== "SUPERSEDED") ?? list[0];

        // Every issue shown on any review of this pull request, and whether a fix for it was applied.
        const issues = new Map<string, boolean>();
        for (const run of list) {
            for (const f of shownFindings(run)) {
                const fixed = f.fixes.some(x => x.status === "IMPLEMENTED");
                issues.set(issueKey(f), (issues.get(issueKey(f)) ?? false) || fixed);
            }
        }
        const found = issues.size;
        const fixed = Array.from(issues.values()).filter(Boolean).length;

        const currentShown = shownFindings(current);
        const failed = FAILED.includes(current.status) || isStalled(current, now);
        const inProgress = IN_PROGRESS.includes(current.status) && !failed;
        const hasResult = !failed && !inProgress && current.status !== "SUPERSEDED";
        const toDecide = current.status === "AWAITING_APPROVAL"
            ? currentShown.flatMap(f => f.fixes).filter(x => x.status === "READY" || x.status === "IMPLEMENT_FAILED").length
            : 0;
        // An issue whose fix was applied on this very review stays listed until the re-scan confirms it.
        const open = hasResult ? currentShown.length : null;
        const awaitingRecheck = hasResult && currentShown.length > 0 && currentShown.every(f => f.fixes.some(x => x.status === "IMPLEMENTED"));

        let status: Pick<ReviewListItem, "label" | "tone" | "group">;
        if (failed) status = { label: "Did not complete", tone: "danger", group: "failed" };
        else if (inProgress) status = { label: fixed > 0 ? "Re-checking after the fix" : "In progress", tone: "info", group: "progress" };
        else if (toDecide > 0) status = { label: "Needs your decision", tone: "warning", group: "decision" };
        else if (awaitingRecheck) status = { label: "Fix applied, not yet verified", tone: "info", group: "progress" };
        else if (open !== null && open > 0) status = { label: "Issues found", tone: "warning", group: "issues" };
        else if (open === 0 && fixed > 0) status = { label: "Fixed and verified", tone: "success", group: "clean" };
        else if (open === 0 && found > 0) status = { label: "Resolved", tone: "success", group: "clean" };
        else if (open === 0) status = { label: "No issues", tone: "success", group: "clean" };
        else status = { label: "Replaced by a newer commit", tone: "neutral", group: "clean" };

        items.push({
            runId: current.id,
            repository: `${current.repository.owner}/${current.repository.name}`,
            prNumber: current.pullRequest.number,
            prTitle: current.pullRequest.title,
            prUrl: current.pullRequest.url,
            headSha: current.headSha.substring(0, 7),
            updatedAt: iso(current.updatedAt),
            ...status,
            counts: { found, fixed, toDecide, open },
            earlier: list.filter(r => r.id !== current.id).map(r => ({
                runId: r.id,
                headSha: r.headSha.substring(0, 7),
                updatedAt: iso(r.updatedAt),
                label: earlierLabel(r, now),
            })),
        });
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
