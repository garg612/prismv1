import { Eye, EyeOff } from "lucide-react";
import type { FindingView } from "@/modules/review/lib/review-view";

/**
 * Why an issue is shown or filtered out, in one sentence, with PRism's risk score on a scale
 * when there is one. The marker on the scale is the score from which issues are shown.
 */
export function TriageNote({ reason, triage, shown }: { reason: string; triage: FindingView["triage"]; shown: boolean }) {
    if (!reason && !triage) return null;
    const Icon = shown ? Eye : EyeOff;
    const above = triage ? triage.score >= triage.showFrom : false;

    return (
        <div className="flex flex-col gap-3 rounded-md border bg-muted/30 px-4 py-3">
            <div className="flex items-start gap-2.5">
                <Icon className={`mt-0.5 size-4 shrink-0 ${shown ? "text-primary-text" : "text-muted-foreground"}`} aria-hidden />
                <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {shown ? "Why you are seeing this" : "Why this was filtered out"}
                    </div>
                    {reason && <p className="text-sm text-pretty">{reason}</p>}
                </div>
            </div>

            {triage && (
                <div className="flex flex-col gap-1.5 pl-6.5">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-muted-foreground">Risk score</span>
                        <span className="tabular-nums">
                            <span className={`text-sm font-semibold ${above ? "text-destructive" : "text-foreground"}`}>{triage.score}</span>
                            <span className="text-muted-foreground"> / 100</span>
                        </span>
                    </div>
                    <div
                        className="relative h-2 rounded-full bg-muted"
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={triage.score}
                        aria-label={`Risk score ${triage.score} out of 100. Issues are shown from ${triage.showFrom}.`}
                    >
                        <div className={`h-full rounded-full ${above ? "bg-destructive" : "bg-muted-foreground/50"}`} style={{ width: `${Math.max(2, Math.min(100, triage.score))}%` }} />
                        <div className="absolute -top-1 h-4 w-0.5 rounded bg-foreground" style={{ left: `${triage.showFrom}%` }} aria-hidden />
                    </div>
                    <div className="relative h-4 text-[0.7rem] text-muted-foreground">
                        <span className="absolute left-0">0 · noise</span>
                        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${triage.showFrom}%` }}>shown from {triage.showFrom}</span>
                        <span className="absolute right-0">100 · real</span>
                    </div>
                </div>
            )}
        </div>
    );
}
