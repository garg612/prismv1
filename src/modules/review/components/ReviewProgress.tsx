import { Check, Loader2, Minus, User, X } from "lucide-react";
import type { StepState, StepView } from "@/modules/review/lib/review-view";

const STATE_LABEL: Record<StepState, string> = {
    done: "Done",
    active: "In progress",
    waiting: "Waiting for you",
    failed: "Failed",
    skipped: "Not needed",
    todo: "Not started",
};

const DOT: Record<StepState, string> = {
    done: "border-success bg-success text-success-foreground",
    active: "border-primary bg-primary/10 text-primary-text",
    waiting: "border-warning bg-warning/15 text-warning",
    failed: "border-destructive bg-destructive/10 text-destructive",
    skipped: "border-border bg-muted text-muted-foreground/60",
    todo: "border-border bg-card text-muted-foreground/40",
};

function StepDot({ state, index }: { state: StepState; index: number }) {
    const icon = "size-3.5";
    return (
        <span className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${DOT[state]}`} role="img" aria-label={STATE_LABEL[state]}>
            {state === "done" ? <Check className={icon} aria-hidden />
                : state === "active" ? <Loader2 className={`${icon} animate-spin`} aria-hidden />
                : state === "waiting" ? <User className={icon} aria-hidden />
                : state === "failed" ? <X className={icon} aria-hidden />
                : state === "skipped" ? <Minus className={icon} aria-hidden />
                : index + 1}
        </span>
    );
}

const COLUMNS: Record<number, string> = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4", 5: "sm:grid-cols-5" };

/** The stages of a review, left to right, joined by a line that fills in as stages complete. */
export function ReviewProgress({ steps }: { steps: StepView[] }) {
    return (
        <ol className={`grid gap-x-2 gap-y-4 rounded-lg border bg-card p-5 ${COLUMNS[steps.length] ?? "sm:grid-cols-5"}`} aria-label="Review progress">
            {steps.map((step, index) => {
                const quiet = step.state === "skipped" || step.state === "todo";
                const last = index === steps.length - 1;
                return (
                    <li key={step.key} className="flex gap-3 sm:flex-col sm:gap-2" aria-current={step.state === "active" || step.state === "waiting" ? "step" : undefined}>
                        <div className="flex items-center gap-2 sm:w-full">
                            <StepDot state={step.state} index={index} />
                            {!last && <span className={`hidden h-px flex-1 sm:block ${step.state === "done" ? "bg-success" : "bg-border"}`} aria-hidden />}
                        </div>
                        <div className="min-w-0 sm:pr-3">
                            <div className={`text-sm font-medium ${quiet ? "text-muted-foreground" : ""}`}>{step.label}</div>
                            {step.detail && <div className="text-xs text-muted-foreground text-pretty">{step.detail}</div>}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
