import { Suspense } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requireAuth } from "@/modules/auth/utils/authUtils";
import { loadMetrics, METRIC_RANGES, parseRange } from "@/modules/metrics/lib/load-metrics";
import { MIN_SAMPLE, Rate } from "@/modules/metrics/lib/metrics";
import { ReviewsNav } from "@/modules/review/components/ReviewsNav";
import { FixDecisionsByWeekChart, IssuesByWeekChart } from "@/modules/metrics/components/InsightsCharts";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** A rate, or an honest "not enough data" with how many more decisions are needed. */
function RateTile({ title, rate, good, countLabel, footnote }: { title: string; rate: Rate; good: "low" | "high"; countLabel: string; footnote: string }) {
    const tone = rate.value === null ? "text-muted-foreground"
        : (good === "low" ? rate.value <= 0.2 : rate.value >= 0.6) ? "text-success"
        : (good === "low" ? rate.value >= 0.5 : rate.value <= 0.3) ? "text-destructive"
        : "text-warning";
    return (
        <div className="flex flex-col gap-1 rounded-lg border bg-card p-5">
            <div className="text-sm font-medium text-muted-foreground">{title}</div>
            {rate.value !== null ? (
                <div className={`text-3xl font-semibold tabular-nums ${tone}`}>{percent(rate.value)}</div>
            ) : (
                <div className="text-lg font-semibold text-muted-foreground">Not enough data</div>
            )}
            <div className="text-sm tabular-nums">
                {rate.count} of {rate.of} {countLabel}
            </div>
            <div className="mt-auto pt-2 text-xs text-muted-foreground text-pretty">
                {rate.value === null ? `A percentage appears after ${MIN_SAMPLE} decisions (${Math.max(0, MIN_SAMPLE - rate.of)} more needed). ` : ""}
                {footnote}
            </div>
        </div>
    );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
            <div>
                <h2 className="text-base font-semibold">{title}</h2>
                <p className="text-sm text-muted-foreground text-pretty">{description}</p>
            </div>
            {children}
        </section>
    );
}

function InsightsSkeleton() {
    return (
        <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading insights">
            <div className="grid gap-4 sm:grid-cols-2">
                {[0, 1].map(i => <div key={i} className="h-36 animate-pulse rounded-lg bg-muted" />)}
            </div>
            <div className="h-80 animate-pulse rounded-lg bg-muted" />
        </div>
    );
}

async function Insights({ searchParams }: { searchParams: SearchParams }) {
    const session = await requireAuth();
    const days = parseRange((await searchParams).days);
    const { metrics, reviews, repositories, truncated } = await loadMetrics(session.user.id, days);
    const funnelMax = Math.max(1, ...metrics.funnel.map(f => f.count));
    const empty = metrics.issues.total === 0;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Lock className="size-3.5" aria-hidden />
                    Only you can see this. It covers {reviews} {reviews === 1 ? "review" : "reviews"} in your {repositories === 1 ? "repository" : `${repositories} repositories`}.
                </p>
                <div role="group" aria-label="Time range" className="flex gap-1.5">
                    {METRIC_RANGES.map(range => (
                        <Link
                            key={range}
                            href={`/dashboard/reviews/insights?days=${range}`}
                            aria-current={range === days ? "true" : undefined}
                            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                                range === days ? "border-primary bg-primary/10 text-primary-text" : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            Last {range} days
                        </Link>
                    ))}
                </div>
            </div>

            {empty ? (
                <p className="rounded-lg border border-dashed px-5 py-12 text-center text-sm text-muted-foreground">
                    No issues were found in the last {days} days, so there is nothing to measure yet.
                </p>
            ) : (
                <>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <RateTile
                            title="False-alarm rate"
                            rate={metrics.falseAlarms}
                            good="low"
                            countLabel="judged issues were marked as a false alarm"
                            footnote={`${metrics.falseAlarms.count} marked “No, false alarm”, ${metrics.falseAlarms.real} confirmed real, ${metrics.falseAlarms.noise ? `${metrics.falseAlarms.noise} marked as noise, ` : ""}${metrics.falseAlarms.unjudged} not answered yet.`}
                        />
                        <RateTile
                            title="Fix acceptance rate"
                            rate={metrics.fixes}
                            good="high"
                            countLabel="decided fixes were applied"
                            footnote={`${metrics.fixes.rejected} rejected, ${metrics.fixes.waiting} waiting for a decision.`}
                        />
                    </div>

                    <div className="grid gap-4 lg:grid-cols-2">
                        <Panel title="Issues found per week" description="Distinct scanner issues by the week they were first found: shown to you, or filtered out as noise.">
                            <IssuesByWeekChart weeks={metrics.weeks} />
                        </Panel>
                        <Panel title="Fix decisions per week" description="Suggested fixes you applied or rejected, by the week of the decision.">
                            <FixDecisionsByWeekChart weeks={metrics.weeks} />
                        </Panel>
                    </div>

                    <Panel title="From issue to applied fix" description="How many distinct scanner issues reached each stage, and why the others did not.">
                        <ol className="flex flex-col gap-4">
                            {metrics.funnel.map((stage, i) => {
                                const previous = i > 0 ? metrics.funnel[i - 1].count : null;
                                const dropped = previous !== null ? previous - stage.count : 0;
                                return (
                                    <li key={stage.key} className="flex flex-col gap-1.5">
                                        <div className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[11rem_1fr_7rem]">
                                            <span className="text-sm font-medium">{stage.label}</span>
                                            <span className="h-3 overflow-hidden rounded-full bg-muted" aria-hidden>
                                                <span className="block h-full rounded-full bg-primary" style={{ width: `${(stage.count / funnelMax) * 100}%` }} />
                                            </span>
                                            <span className="text-sm tabular-nums sm:text-right">
                                                <span className="font-semibold">{stage.count}</span>
                                                {previous !== null && previous > 0 && <span className="text-muted-foreground"> ({percent(stage.count / previous)})</span>}
                                            </span>
                                        </div>
                                        {stage.note && (
                                            <p className="text-xs text-muted-foreground text-pretty sm:pl-[11.75rem]">
                                                {dropped > 0 && <span className="font-medium text-foreground">{dropped} fewer than the stage above: </span>}
                                                {stage.note}
                                            </p>
                                        )}
                                    </li>
                                );
                            })}
                        </ol>
                        <p className="text-xs text-muted-foreground">Percentages are relative to the stage above.</p>
                    </Panel>

                    <details className="rounded-lg border bg-card text-sm">
                        <summary className="cursor-pointer px-5 py-3 font-medium">How these numbers are counted</summary>
                        <dl className="grid gap-x-6 gap-y-3 border-t px-5 py-4 sm:grid-cols-[12rem_1fr]">
                            <dt className="font-medium">An issue</dt>
                            <dd className="text-muted-foreground">Something a scanner reported in a pull request. If the same issue is found again on a later commit of that pull request, it is still one issue.</dd>

                            <dt className="font-medium">False-alarm rate</dt>
                            <dd className="text-muted-foreground">
                                Of the shown issues you judged, the share you marked “No, false alarm”. An issue counts as real when you answered “Yes”, or applied its fix without answering. Issues you have not judged are left out. Your latest answer is the one that counts, and you have one answer per issue.
                            </dd>

                            <dt className="font-medium">Fix acceptance rate</dt>
                            <dd className="text-muted-foreground">Of the suggested fixes you decided on, the share you applied. Fixes still waiting for a decision are left out. Rejecting a fix does not mark its issue as a false alarm.</dd>

                            <dt className="font-medium">Shown or filtered out</dt>
                            <dd className="text-muted-foreground">Triage rates every issue. Issues rated as noise are filtered out and listed in a closed section of the review, where you can still bring one back.</dd>

                            <dt className="font-medium">Issue to applied fix</dt>
                            <dd className="text-muted-foreground">Each stage counts issues, not fixes. An issue has a validated fix when one of its suggested fixes passed every check, and an applied fix when you accepted one.</dd>

                            <dt className="font-medium">Percentages</dt>
                            <dd className="text-muted-foreground">A rate is only shown once at least {MIN_SAMPLE} decisions stand behind it. Below that you see the counts.</dd>

                            <dt className="font-medium">What is not counted</dt>
                            <dd className="text-muted-foreground">AI suggestions about possible logic bugs: they are optional reading. Anything from other accounts: only your decisions, in repositories you own, are counted, and only they influence how your future issues are triaged.</dd>
                        </dl>
                    </details>

                    {truncated && <p className="text-xs text-muted-foreground">This period has more findings than can be loaded at once, so the oldest ones are not included.</p>}
                </>
            )}
        </div>
    );
}

export default function InsightsPage({ searchParams }: { searchParams: SearchParams }) {
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <PageHeader title="Reviews" description="How accurate PRism has been on your pull requests." />
            <ReviewsNav active="insights" />
            <Suspense fallback={<InsightsSkeleton />}>
                <Insights searchParams={searchParams} />
            </Suspense>
        </div>
    );
}
