"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Eye, Loader2, ThumbsDown, ThumbsUp, ChevronDown, EyeOff, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Verdict = "REAL" | "FALSE_ALARM" | "NOISE";
type Action = "TRUE_POSITIVE" | "FALSE_POSITIVE" | "CLEAR" | "UNSUPPRESS" | "MARK_AS_NOISE";

interface Props {
    findingId: string;
    /** The answer already saved for the signed-in user */
    initialVerdict: Verdict | null;
    question: string;
    realLabel: string;
    falseAlarmLabel: string;
    /** Offer "Show this issue" for an issue that was filtered out as noise */
    canUnsuppress?: boolean;
}

const SAVED_TEXT: Record<Verdict, string> = {
    REAL: "You marked this as a real issue.",
    FALSE_ALARM: "You marked this as a false alarm.",
    NOISE: "You marked this as noise.",
};

const NOISE_REASONS = [
    { value: "TEST_CODE", label: "Test Code" },
    { value: "INTENTIONAL_CODE", label: "Intentional Code" },
    { value: "GENERATED_CODE", label: "Generated Code" },
    { value: "VENDOR_CODE", label: "Vendor/Third-party" },
];

const FALSE_ALARM_REASONS = [
    { value: "TOOL_ERROR", label: "Tool Error" },
    { value: "WRONG_CONTEXT", label: "Wrong Context" },
    { value: "DUPLICATE", label: "Duplicate" },
    { value: "OTHER", label: "Other" },
];

/**
 * "Is this real?" for one issue. The saved answer comes from the server, so it is still there
 * after a reload, and it can be changed or withdrawn. Each person has one answer per issue.
 */
export function FeedbackButtons({ findingId, initialVerdict, question, realLabel, falseAlarmLabel, canUnsuppress = false }: Props) {
    const router = useRouter();
    const [verdict, setVerdict] = useState<Verdict | null>(initialVerdict);
    const [pending, setPending] = useState<Action | null>(null);
    const [error, setError] = useState<string | null>(null);

    const send = async (action: Action, reason?: string) => {
        setPending(action);
        setError(null);
        try {
            const res = await fetch(`/api/findings/${findingId}/feedback`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action, reason }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(res.status === 429 ? "Too many requests. Wait a moment and try again." : body.error || "Could not save your answer. Try again.");
                return;
            }
            setVerdict(body.verdict ?? null);
            // The issue moves to another section, and the insights numbers change.
            if (body.unsuppressed) router.refresh();
        } catch {
            setError("Could not save your answer. Check your connection and try again.");
        } finally {
            setPending(null);
        }
    };

    const busy = pending !== null;
    const spinner = (action: Action) => pending === action && <Loader2 className="size-3.5 animate-spin" aria-hidden />;

    return (
        <footer className="flex flex-wrap items-center gap-2 border-t pt-4 text-xs text-muted-foreground">
            {verdict ? (
                <>
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                        <Check className="size-3.5 text-success" aria-hidden /> {SAVED_TEXT[verdict]}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => send("CLEAR")} disabled={busy}>
                        {spinner("CLEAR")}
                        Undo
                    </Button>
                </>
            ) : (
                <>
                    <span className="mr-1">{question}</span>
                    
                    <Button variant="outline" size="sm" onClick={() => send("TRUE_POSITIVE")} disabled={busy}>
                        {spinner("TRUE_POSITIVE") || <ThumbsUp className="size-3.5" aria-hidden />}
                        {realLabel}
                    </Button>
                    
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" disabled={busy}>
                                {spinner("MARK_AS_NOISE") || <EyeOff className="size-3.5" aria-hidden />}
                                Mark as noise <ChevronDown className="ml-1 size-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {NOISE_REASONS.map(r => (
                                <DropdownMenuItem key={r.value} onClick={() => send("MARK_AS_NOISE", r.value)}>
                                    {r.label}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" disabled={busy}>
                                {spinner("FALSE_POSITIVE") || <Bug className="size-3.5 text-destructive" aria-hidden />}
                                False alarm <ChevronDown className="ml-1 size-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {FALSE_ALARM_REASONS.map(r => (
                                <DropdownMenuItem key={r.value} onClick={() => send("FALSE_POSITIVE", r.value)}>
                                    {r.label}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )}
            
            {canUnsuppress && (
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => send("UNSUPPRESS")} disabled={busy}>
                    {spinner("UNSUPPRESS") || <Eye className="size-3.5" aria-hidden />}
                    Show this issue
                </Button>
            )}
            {error && <span role="alert" className="basis-full text-destructive">{error}</span>}
        </footer>
    );
}
