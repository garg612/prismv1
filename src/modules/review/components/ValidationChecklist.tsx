import { CheckCircle2, Minus, XCircle } from "lucide-react";
import type { CheckView } from "@/modules/review/lib/review-view";

function CheckIcon({ state }: { state: CheckView["state"] }) {
    const size = "size-4 shrink-0 mt-0.5";
    if (state === "passed") return <CheckCircle2 className={`${size} text-success`} aria-label="Passed" />;
    if (state === "failed") return <XCircle className={`${size} text-destructive`} aria-label="Failed" />;
    return <Minus className={`${size} text-muted-foreground/50`} aria-label="Not run" />;
}

export function ValidationChecklist({ checks, executionNote }: { checks: CheckView[]; executionNote: string | null }) {
    if (checks.length === 0 && !executionNote) return null;

    return (
        <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">How this fix was checked</h4>
            {checks.length > 0 && (
                <ul className="space-y-1.5">
                    {checks.map(check => (
                        <li key={check.label} className="flex items-start gap-2 text-sm">
                            <CheckIcon state={check.state} />
                            <span>
                                {check.label}
                                {check.detail && <span className="text-muted-foreground"> — {check.detail}</span>}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {executionNote && <p className="text-xs text-muted-foreground text-pretty">{executionNote}</p>}
        </div>
    );
}
