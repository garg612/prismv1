"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { acceptFix, rejectFix } from "@/modules/review/actions/fixes";
import { fixErrorMessage } from "@/modules/review/lib/fix-errors";
import type { DiffLine, FixView } from "@/modules/review/lib/review-view";
import { ValidationChecklist } from "./ValidationChecklist";
import { tonePill } from "./tone";

const diffLineClass: Record<DiffLine["kind"], string> = {
    add: "bg-success/10 text-success",
    del: "bg-destructive/10 text-destructive",
    hunk: "text-muted-foreground",
    ctx: "",
};

export function FixProposalCard({ fix }: { fix: FixView }) {
    const router = useRouter();
    const [pending, setPending] = useState<"accept" | "reject" | null>(null);
    const [error, setError] = useState<string | null>(null);

    const decide = async (action: "accept" | "reject") => {
        setPending(action);
        setError(null);
        try {
            const res = action === "accept" ? await acceptFix(fix.id) : await rejectFix(fix.id);
            if (!res.success) setError(fixErrorMessage(res.error));
        } catch {
            setError("Something went wrong. Nothing was changed.");
        } finally {
            setPending(null);
            router.refresh();
        }
    };

    return (
        <section className="rounded-lg border bg-muted/20">
            <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <h3 className="text-sm font-semibold">Suggested fix</h3>
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tonePill[fix.tone]}`}>
                    {pending === "accept" ? "Applying" : fix.statusLabel}
                </span>
            </header>

            <div className="flex flex-col gap-5 p-4">
                {fix.problem && <p className="text-sm text-pretty">{fix.problem}</p>}
                {fix.explanation && <p className="text-sm text-pretty">{fix.explanation}</p>}

                {fix.diff.length > 0 && (
                    <div className="overflow-hidden rounded-md border">
                        <div className="flex items-center justify-between gap-3 border-b bg-muted px-3 py-1.5 font-mono text-xs">
                            <span className="truncate">{fix.filePath}</span>
                            <span className="shrink-0 tabular-nums">
                                <span className="text-success">+{fix.linesAdded}</span>{" "}
                                <span className="text-destructive">-{fix.linesRemoved}</span>
                            </span>
                        </div>
                        <pre className="overflow-x-auto bg-card py-2 font-mono text-xs leading-5">
                            {fix.diff.map((line, i) => (
                                <div key={i} className={`px-3 ${diffLineClass[line.kind]}`}>{line.text || " "}</div>
                            ))}
                        </pre>
                    </div>
                )}

                <ValidationChecklist checks={fix.checks} executionNote={fix.executionNote} />

                {fix.applied && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm">
                        <span className="text-pretty">{fix.applied.summary}</span>
                        {fix.applied.linkUrl && (
                            <a href={fix.applied.linkUrl} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 font-medium text-primary-text hover:underline">
                                {fix.applied.linkLabel} <ExternalLink className="size-3.5" />
                            </a>
                        )}
                    </div>
                )}

                {fix.decisionBlockedReason && <p className="text-sm text-muted-foreground text-pretty">{fix.decisionBlockedReason}</p>}

                {error && (
                    <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        {error}
                    </p>
                )}

                {fix.canDecide && (
                    <div className="flex justify-end gap-2 border-t pt-4">
                        <Button variant="outline" onClick={() => decide("reject")} disabled={pending !== null}>
                            Reject
                        </Button>
                        <Button onClick={() => decide("accept")} disabled={pending !== null}>
                            {pending === "accept" && <Loader2 className="size-4 animate-spin" />}
                            Apply fix
                        </Button>
                    </div>
                )}
            </div>
        </section>
    );
}
