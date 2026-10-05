import { ChevronRight, Lightbulb, Sparkles } from "lucide-react";
import type { LogicIssueView, LogicReviewView } from "@/modules/review/lib/review-view";
import { CodeSnippet } from "./CodeSnippet";
import { InlineText } from "./InlineText";

function Suggestion({ issue, index }: { issue: LogicIssueView; index: number }) {
    return (
        <li className="flex gap-4 border-t px-5 py-5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary-text" aria-hidden>
                {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary-text">{issue.category}</span>
                        <span className="font-mono text-xs text-muted-foreground">{issue.location}</span>
                    </div>
                    <h3 className="text-base font-semibold text-pretty"><InlineText text={issue.title} /></h3>
                </div>

                {issue.snippet && <CodeSnippet code={issue.snippet} startLine={issue.line} />}

                <p className="text-sm leading-6 text-pretty"><InlineText text={issue.explanation} /></p>

                {issue.suggestion && (
                    <div className="flex gap-2.5 rounded-md border-l-2 border-success bg-success/5 px-3 py-2.5">
                        <Lightbulb className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                        <div className="min-w-0">
                            <div className="text-xs font-semibold uppercase tracking-wider text-success">Possible change</div>
                            <p className="text-sm leading-6 text-pretty"><InlineText text={issue.suggestion} /></p>
                        </div>
                    </div>
                )}
            </div>
        </li>
    );
}

/**
 * Optional reading: what an AI model noticed in the diff that could be a logic bug.
 * These are not issues. PRism does not count them, track them or fix them, and nothing on the
 * page depends on them, so the section stays closed until the reader opens it.
 */
export function LogicReviewSection({ review }: { review: LogicReviewView }) {
    const count = review.issues.length;

    if (count === 0) {
        return (
            <p className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-5 py-3 text-sm text-pretty">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary-text" aria-hidden />
                <span><span className="font-medium">AI suggestions (optional). </span><span className="text-muted-foreground">{review.summary}</span></span>
            </p>
        );
    }

    return (
        <details className="group overflow-hidden rounded-lg border border-primary/25 bg-card">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 bg-primary/5 px-5 py-3 text-sm marker:content-none hover:bg-primary/10">
                <ChevronRight className="size-3.5 text-primary-text transition-transform group-open:rotate-90" aria-hidden />
                <Sparkles className="size-4 text-primary-text" aria-hidden />
                <span className="font-semibold">AI suggestions</span>
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary-text">{count}</span>
                <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Optional</span>
                <span className="text-muted-foreground">Possible logic bugs you may want to look at.</span>
            </summary>
            <p className="border-t px-5 py-3 text-sm text-muted-foreground text-pretty">
                {review.summary} They are not confirmed by a scanner or by tests. PRism does not track or fix them, and they do not change the result of this review.
            </p>
            <ol>
                {review.issues.map((issue, index) => <Suggestion key={issue.id} issue={issue} index={index} />)}
            </ol>
        </details>
    );
}
