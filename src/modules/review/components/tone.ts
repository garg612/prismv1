import type { Tone } from "@/modules/review/lib/review-view";

/** Semantic colour classes per tone. Only theme tokens, never literal colours. */
export const toneText: Record<Tone, string> = {
    success: "text-success",
    danger: "text-destructive",
    warning: "text-warning",
    info: "text-primary-text",
    neutral: "text-muted-foreground",
};

export const tonePill: Record<Tone, string> = {
    success: "bg-success/10 text-success border-success/20",
    danger: "bg-destructive/10 text-destructive border-destructive/20",
    warning: "bg-warning/10 text-warning border-warning/20",
    info: "bg-primary/10 text-primary-text border-primary/20",
    neutral: "bg-muted text-muted-foreground border-border",
};

export const toneBar: Record<Tone, string> = {
    success: "border-l-success",
    danger: "border-l-destructive",
    warning: "border-l-warning",
    info: "border-l-primary",
    neutral: "border-l-border",
};
