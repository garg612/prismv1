"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ChevronRight, ExternalLink, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { ReviewListGroup, ReviewListItem } from "@/modules/review/lib/review-list";
import { tonePill, toneText } from "./tone";

type Filter = "all" | ReviewListGroup;

const FILTERS: Array<{ key: Filter; label: string }> = [
    { key: "all", label: "All" },
    { key: "decision", label: "Needs your decision" },
    { key: "progress", label: "In progress" },
    { key: "issues", label: "Issues found" },
    { key: "clean", label: "Clean" },
    { key: "failed", label: "Did not complete" },
];

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

function Count({ value, label, tone }: { value: number | null; label: string; tone: "danger" | "warning" | "success" | "neutral" }) {
    return (
        <div className="flex min-w-14 flex-col">
            <span className={`text-lg font-semibold tabular-nums ${value ? toneText[tone] : "text-muted-foreground/60"}`} title={value === null ? "Not known until the current review finishes" : undefined}>
                {value ?? "–"}
            </span>
            <span className="text-xs text-muted-foreground">{label}</span>
        </div>
    );
}

function ReviewRow({ item }: { item: ReviewListItem }) {
    return (
        <li className="rounded-lg border bg-card transition-colors hover:border-foreground/20">
            <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-5">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className={`rounded-full border px-2.5 py-0.5 font-medium ${tonePill[item.tone]}`}>{item.label}</span>
                        <span className="text-muted-foreground">{item.repository}</span>
                        <span className="text-muted-foreground" aria-hidden>·</span>
                        <time className="text-muted-foreground" dateTime={item.updatedAt} suppressHydrationWarning>{ago(item.updatedAt)}</time>
                    </div>
                    <Link href={`/dashboard/reviews/${item.runId}`} className="truncate text-base font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                        {item.prTitle}
                    </Link>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <a href={item.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                            #{item.prNumber} <ExternalLink className="size-3" aria-hidden />
                            <span className="sr-only">(opens on GitHub)</span>
                        </a>
                        <span aria-hidden>·</span>
                        <span>commit <span className="font-mono">{item.headSha}</span></span>
                    </div>
                </div>

                <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-start sm:gap-5">
                    <Count value={item.counts.found} label="found" tone="neutral" />
                    <Count value={item.counts.fixed} label="fixed" tone="success" />
                    <Count value={item.counts.toDecide} label="to decide" tone="warning" />
                    <Count value={item.counts.open} label="still open" tone="danger" />
                    <Link href={`/dashboard/reviews/${item.runId}`} aria-label={`Open the review of ${item.prTitle}`} className="hidden rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:block">
                        <ChevronRight className="size-4" aria-hidden />
                    </Link>
                </div>
            </div>

            {item.earlier.length > 0 && (
                <details className="group border-t text-xs">
                    <summary className="flex cursor-pointer items-center gap-1.5 px-5 py-2 text-muted-foreground marker:content-none hover:text-foreground">
                        <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
                        {item.earlier.length} earlier {item.earlier.length === 1 ? "review" : "reviews"} of this pull request (older commits)
                    </summary>
                    <ul className="flex flex-col gap-1 px-5 pb-3 pl-10">
                        {item.earlier.map(run => (
                            <li key={run.runId} className="flex flex-wrap items-center gap-x-2">
                                <Link href={`/dashboard/reviews/${run.runId}`} className="font-mono text-primary-text hover:underline">{run.headSha}</Link>
                                <span className="text-muted-foreground">{run.label}</span>
                                <span className="text-muted-foreground" aria-hidden>·</span>
                                <time className="text-muted-foreground" dateTime={run.updatedAt} suppressHydrationWarning>{ago(run.updatedAt)}</time>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </li>
    );
}

export function ReviewList({ items }: { items: ReviewListItem[] }) {
    const [filter, setFilter] = useState<Filter>("all");
    const [query, setQuery] = useState("");

    const counts = useMemo(() => {
        const c: Record<Filter, number> = { all: items.length, decision: 0, progress: 0, issues: 0, clean: 0, failed: 0 };
        for (const item of items) c[item.group]++;
        return c;
    }, [items]);

    const q = query.trim().toLowerCase();
    const visible = items.filter(item =>
        (filter === "all" || item.group === filter)
        && (q === "" || item.prTitle.toLowerCase().includes(q) || item.repository.toLowerCase().includes(q) || `#${item.prNumber}`.includes(q) || item.headSha.includes(q))
    );

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div role="group" aria-label="Filter reviews" className="flex flex-wrap gap-1.5">
                    {FILTERS.filter(f => f.key === "all" || counts[f.key] > 0).map(f => (
                        <button
                            key={f.key}
                            type="button"
                            aria-pressed={filter === f.key}
                            onClick={() => setFilter(f.key)}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                                filter === f.key ? "border-primary bg-primary/10 text-primary-text" : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {f.label}
                            <span className="tabular-nums opacity-70">{counts[f.key]}</span>
                        </button>
                    ))}
                </div>
                <div className="relative lg:w-72">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                        type="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search title, repository, #number"
                        aria-label="Search reviews"
                        className="pl-8"
                    />
                </div>
            </div>

            {visible.length === 0 ? (
                <p className="rounded-lg border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
                    No review matches this filter.
                </p>
            ) : (
                <ul className="flex flex-col gap-3">
                    {visible.map(item => <ReviewRow key={item.runId} item={item} />)}
                </ul>
            )}
        </div>
    );
}
