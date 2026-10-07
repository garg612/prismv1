import { CheckCircle2, Minus, XCircle, Loader2 } from "lucide-react";
import type { CheckView } from "@/modules/review/lib/review-view";

function CheckIcon({ state }: { state: CheckView["state"] }) {
    const size = "size-4 shrink-0 mt-0.5";
    if (state === "passed") return <CheckCircle2 className={`${size} text-success`} aria-label="Passed" />;
    if (state === "failed") return <XCircle className={`${size} text-destructive`} aria-label="Failed" />;
    if ((state as string) === "running") return <Loader2 className={`${size} text-blue-500 animate-spin`} aria-label="Running" />;
    return <Minus className={`${size} text-muted-foreground/50`} aria-label="Not run" />;
}

export function ValidationChecklist({ staticChecks, execChecks, executionNote }: { staticChecks: CheckView[]; execChecks: CheckView[]; executionNote: string | null }) {
    if (staticChecks.length === 0 && execChecks.length === 0 && !executionNote) return null;

    const renderChecks = (checks: CheckView[]) => (
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
    );

    return (
        <div className="space-y-4">
            {staticChecks.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Validating fix in isolated environment</h4>
                    {renderChecks(staticChecks)}
                </div>
            )}
            
            {(execChecks.length > 0 || executionNote) && (
                <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Validating repository health</h4>
                    {execChecks.length > 0 && renderChecks(execChecks)}
                    {executionNote && <p className="text-xs text-muted-foreground text-pretty">{executionNote}</p>}
                </div>
            )}
        </div>
    );
}
