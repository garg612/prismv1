"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { WeekPoint } from "@/modules/metrics/lib/metrics";

const issuesConfig = {
    shown: { label: "Shown to you", color: "var(--chart-1)" },
    filtered: { label: "Filtered out as noise", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

const fixesConfig = {
    accepted: { label: "Applied", color: "var(--success)" },
    rejected: { label: "Rejected", color: "var(--destructive)" },
} satisfies ChartConfig;

const weekLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
const tooltipLabel = (iso: unknown) => `Week of ${weekLabel(String(iso))}`;

function Chart({ data, config, keys, stacked, summary }: { data: WeekPoint[]; config: ChartConfig; keys: string[]; stacked: boolean; summary: string }) {
    return (
        <ChartContainer config={config} className="aspect-auto h-64 w-full" role="img" aria-label={summary}>
            <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="weekStart" tickFormatter={weekLabel} tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={tooltipLabel} />} />
                <ChartLegend content={<ChartLegendContent />} />
                {keys.map((key, i) => (
                    <Bar
                        key={key}
                        dataKey={key}
                        stackId={stacked ? "a" : undefined}
                        fill={`var(--color-${key})`}
                        radius={stacked ? (i === keys.length - 1 ? [3, 3, 0, 0] : 0) : [3, 3, 0, 0]}
                        maxBarSize={36}
                    />
                ))}
            </BarChart>
        </ChartContainer>
    );
}

/** Issues found per week, split by what triage did with them. */
export function IssuesByWeekChart({ weeks }: { weeks: WeekPoint[] }) {
    const total = weeks.reduce((n, w) => n + w.shown + w.filtered, 0);
    return <Chart data={weeks} config={issuesConfig} keys={["shown", "filtered"]} stacked summary={`Bar chart of ${total} scanner issues by the week they were first found, split into shown and filtered out as noise.`} />;
}

/** Fix decisions per week. */
export function FixDecisionsByWeekChart({ weeks }: { weeks: WeekPoint[] }) {
    const total = weeks.reduce((n, w) => n + w.accepted + w.rejected, 0);
    return <Chart data={weeks} config={fixesConfig} keys={["accepted", "rejected"]} stacked={false} summary={`Bar chart of ${total} fix decisions by week, split into applied and rejected.`} />;
}
