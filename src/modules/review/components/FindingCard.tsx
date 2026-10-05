import type { FindingView } from "@/modules/review/lib/review-view";
import { CodeSnippet } from "./CodeSnippet";
import { FeedbackButtons } from "./FeedbackButtons";
import { FixProposalCard } from "./FixProposalCard";
import { InlineText } from "./InlineText";
import { tonePill } from "./tone";
import { TriageNote } from "./TriageNote";

export function FindingCard({ finding }: { finding: FindingView }) {
    return (
        <article className="flex flex-col gap-5 rounded-lg border bg-card p-5">
            <header className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded-full border px-2.5 py-0.5 font-medium ${tonePill[finding.severityTone]}`}>
                        {finding.severity.charAt(0) + finding.severity.slice(1).toLowerCase()} severity
                    </span>
                    <span className="rounded-full border px-2.5 py-0.5 font-medium text-muted-foreground">{finding.scanner}</span>
                    <span className="text-muted-foreground">{finding.originLabel}</span>
                </div>
                <h3 className="text-base font-semibold text-pretty"><InlineText text={finding.title} /></h3>
                <div className="font-mono text-xs text-muted-foreground">
                    {finding.location} · {finding.ruleId}
                </div>
            </header>

            {finding.snippet && (
                <CodeSnippet code={finding.snippet} startLine={finding.line} />
            )}

            <TriageNote reason={finding.reason} triage={finding.triage} shown={finding.isShown} />

            {finding.fix && <FixProposalCard fix={finding.fix} />}

            {finding.failedAttempts.length > 0 && (
                <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer hover:text-foreground">
                        {finding.failedAttempts.length} earlier {finding.failedAttempts.length === 1 ? "attempt" : "attempts"} did not produce a usable fix
                    </summary>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                        {finding.failedAttempts.map(attempt => (
                            <li key={attempt.id} className="break-words">{attempt.reason}</li>
                        ))}
                    </ul>
                </details>
            )}

            <FeedbackButtons
                findingId={finding.id}
                initialVerdict={finding.myVerdict}
                question="Is this a real issue?"
                realLabel="Yes"
                falseAlarmLabel="No, false alarm"
                canUnsuppress={finding.canUnsuppress}
            />
        </article>
    );
}
