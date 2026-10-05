import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, CircleSlash, ExternalLink, GitPullRequest, Info, Loader2, XCircle } from "lucide-react";
import { requireAuth } from "@/modules/auth/utils/authUtils";
import { loadReview } from "@/modules/review/lib/load-review";
import type { FindingView, ReviewView, Tone } from "@/modules/review/lib/review-view";
import { AutoRefresh } from "@/modules/review/components/AutoRefresh";
import { FindingCard } from "@/modules/review/components/FindingCard";
import { LogicReviewSection } from "@/modules/review/components/LogicReviewSection";
import { ReviewProgress } from "@/modules/review/components/ReviewProgress";
import { toneBar, toneText } from "@/modules/review/components/tone";

function CollapsedFindings({ title, hint, findings }: { title: string; hint: string; findings: FindingView[] }) {
    if (findings.length === 0) return null;
    return (
        <details className="group rounded-lg border bg-card">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-5 py-3 text-sm font-medium marker:content-none hover:bg-muted/40">
                <ArrowRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
                {title}
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{findings.length}</span>
                <span className="font-normal text-muted-foreground">{hint}</span>
            </summary>
            <div className="flex flex-col gap-4 border-t p-4">
                {findings.map(finding => <FindingCard key={finding.id} finding={finding} />)}
            </div>
        </details>
    );
}

function ReviewSkeleton() {
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-20" aria-busy="true" aria-label="Loading review">
            <div className="flex flex-col gap-2">
                <div className="h-4 w-64 animate-pulse rounded bg-muted" />
                <div className="h-7 w-96 max-w-full animate-pulse rounded bg-muted" />
            </div>
            <div className="h-32 animate-pulse rounded-lg bg-muted" />
            <div className="h-24 animate-pulse rounded-lg bg-muted" />
            <div className="h-64 animate-pulse rounded-lg bg-muted" />
        </div>
    );
}

function HeadlineIcon({ view }: { view: ReviewView }) {
    const className = `mt-0.5 size-5 shrink-0 ${toneText[view.headline.tone]}`;
    if (view.live && view.headline.tone === "info") return <Loader2 className={`${className} animate-spin`} aria-hidden />;
    const icons: Record<Tone, typeof Info> = { success: CheckCircle2, danger: XCircle, warning: AlertTriangle, info: Info, neutral: CircleSlash };
    const Icon = icons[view.headline.tone];
    return <Icon className={className} aria-hidden />;
}

function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// The session and the review are per-request data, so they load inside a Suspense boundary.
export default function ReviewRunDetailsPage({ params }: { params: Promise<{ id: string }> }) {
    return (
        <Suspense fallback={<ReviewSkeleton />}>
            <ReviewRunDetails params={params} />
        </Suspense>
    );
}

async function ReviewRunDetails({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const session = await requireAuth();

    const review = await loadReview(id, session.user.id);
    if (!review) return notFound();

    const { view, pullRequest, repository } = review;

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-20">
            <AutoRefresh active={view.live} />

            <header className="flex flex-col gap-2">
                <Link href="/dashboard/reviews" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="size-3.5" aria-hidden /> All reviews
                </Link>
                <h1 className="text-2xl font-semibold tracking-tight text-balance">{pullRequest.title}</h1>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span>{repository.owner}/{repository.name}</span>
                    <span aria-hidden>·</span>
                    <a href={pullRequest.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                        <GitPullRequest className="size-3.5" aria-hidden /> #{pullRequest.number} <ExternalLink className="size-3" aria-hidden />
                        <span className="sr-only">(opens on GitHub)</span>
                    </a>
                    <span aria-hidden>·</span>
                    <span>commit <span className="font-mono text-xs">{review.headSha.substring(0, 7)}</span></span>
                    <span aria-hidden>·</span>
                    <time dateTime={review.updatedAt.toISOString()} title={review.updatedAt.toUTCString()}>
                        updated {formatDistanceToNow(review.updatedAt, { addSuffix: true })}
                    </time>
                    {view.durationMs !== null && (
                        <>
                            <span aria-hidden>·</span>
                            <span>took {formatDuration(view.durationMs)}</span>
                        </>
                    )}
                </div>
            </header>

            <section className={`rounded-lg border border-l-4 bg-card ${toneBar[view.headline.tone]}`} aria-live="polite">
                <div className="flex gap-3 px-5 py-4">
                    <HeadlineIcon view={view} />
                    <div className="min-w-0">
                        <div className={`text-base font-semibold ${toneText[view.headline.tone]}`}>{view.headline.label}</div>
                        <p className="text-sm text-muted-foreground text-pretty">{view.headline.detail}</p>
                        {view.headline.technical && (
                            <p className="mt-1 break-words font-mono text-xs text-muted-foreground">Details: {view.headline.technical}</p>
                        )}
                        {view.earlierReview && (
                            <Link href={`/dashboard/reviews/${view.earlierReview.runId}`} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary-text hover:underline">
                                See the review of commit {view.earlierReview.headSha}, where it was found and fixed <ArrowRight className="size-3.5" aria-hidden />
                            </Link>
                        )}
                        {view.newerReview && (
                            <Link href={`/dashboard/reviews/${view.newerReview.runId}`} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary-text hover:underline">
                                See the latest review, for commit {view.newerReview.headSha} <ArrowRight className="size-3.5" aria-hidden />
                            </Link>
                        )}
                    </div>
                </div>
                {!view.live && (
                    <dl className="grid grid-cols-2 border-t sm:grid-flow-col sm:auto-cols-fr sm:grid-cols-none sm:divide-x">
                        {view.stats.map(stat => (
                            <div key={stat.key} className="flex flex-col-reverse gap-0.5 px-5 py-3">
                                <dt className="text-xs text-muted-foreground">{stat.label}</dt>
                                <dd className={`text-xl font-semibold tabular-nums ${stat.value > 0 ? toneText[stat.tone] : "text-muted-foreground"}`}>{stat.value}</dd>
                            </div>
                        ))}
                    </dl>
                )}
            </section>

            <ReviewProgress steps={view.steps} />

            {view.shown.length > 0 && (
                <section className="flex flex-col gap-4" aria-labelledby="scanner-issues-heading">
                    <h2 id="scanner-issues-heading" className="text-lg font-semibold">
                        {view.shown.length === 1 ? "1 issue found by scanners" : `${view.shown.length} issues found by scanners`}
                    </h2>
                    {view.shown.map(finding => <FindingCard key={finding.id} finding={finding} />)}
                </section>
            )}

            {view.logicReview && <LogicReviewSection review={view.logicReview} />}

            <CollapsedFindings title="Filtered out as noise" hint="PRism rated these as unlikely to matter. Open to check them or bring one back." findings={view.filtered} />
        </div>
    );
}
