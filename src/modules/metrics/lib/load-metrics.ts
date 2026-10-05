import prisma from "@/lib/db";
import { buildMetrics, MetricFinding, Metrics, ruleFalseAlarmRates } from "./metrics";

export const METRIC_RANGES = [30, 90, 180] as const;
export type MetricRangeDays = (typeof METRIC_RANGES)[number];

export function parseRange(value: string | string[] | undefined): MetricRangeDays {
    const n = Number(Array.isArray(value) ? value[0] : value);
    return (METRIC_RANGES as readonly number[]).includes(n) ? (n as MetricRangeDays) : 90;
}

/** Rows above this are not loaded; the page says so instead of silently under-counting. */
const MAX_FINDINGS = 20000;

const findingSelect = (userId: string) => ({
    id: true, source: true, ruleId: true, fingerprint: true, occurrence: true, triageDecision: true, createdAt: true,
    reviewRun: { select: { pullRequestId: true } },
    // Only the repository owner's answers count. Nobody else can write feedback, and rows from
    // any other account (old test data, a transferred repository) are ignored here as well.
    feedback: { where: { userId }, select: { kind: true, createdAt: true } },
    fixes: { select: { id: true, status: true, updatedAt: true } },
});

type Row = {
    id: string; source: string; ruleId: string; fingerprint: string; occurrence: number; triageDecision: string | null; createdAt: Date;
    reviewRun: { pullRequestId: string };
    feedback: Array<{ kind: string; createdAt: Date }>;
    fixes: Array<{ id: string; status: string; updatedAt: Date }>;
};

const toMetricFinding = (r: Row): MetricFinding => ({
    id: r.id, pullRequestId: r.reviewRun.pullRequestId, source: r.source, ruleId: r.ruleId, fingerprint: r.fingerprint,
    occurrence: r.occurrence, triageDecision: r.triageDecision, createdAt: r.createdAt, feedback: r.feedback, fixes: r.fixes,
});

export interface LoadedMetrics {
    metrics: Metrics;
    days: MetricRangeDays;
    reviews: number;
    repositories: number;
    truncated: boolean;
}

/** Quality numbers for the repositories `userId` owns. Nothing from any other account is read. */
export async function loadMetrics(userId: string, days: MetricRangeDays, now = new Date()): Promise<LoadedMetrics> {
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const [rows, reviews, repositories] = await Promise.all([
        prisma.finding.findMany({
            where: { createdAt: { gte: from }, source: { not: "CUSTOM" }, reviewRun: { repository: { userId } } },
            select: findingSelect(userId),
            orderBy: { createdAt: "desc" },
            take: MAX_FINDINGS + 1,
        }),
        prisma.reviewRun.count({ where: { repository: { userId }, updatedAt: { gte: from }, status: { notIn: ["SUPERSEDED", "QUEUED"] } } }),
        prisma.repository.count({ where: { userId } }),
    ]);
    const truncated = rows.length > MAX_FINDINGS;
    const findings = (truncated ? rows.slice(0, MAX_FINDINGS) : rows).map(r => toMetricFinding(r as Row));
    return { metrics: buildMetrics(findings, { from, to: now }), days, reviews, repositories, truncated };
}

/**
 * Historical false-alarm rate per rule for the triage model, from the repository owner's own
 * decisions only. One account can therefore never shift how another account's issues are triaged.
 */
export async function loadRuleFalseAlarmRates(ownerUserId: string, ruleIds: string[]): Promise<Map<string, number | null>> {
    if (ruleIds.length === 0) return new Map();
    const rows = await prisma.finding.findMany({
        where: {
            ruleId: { in: ruleIds },
            source: { not: "CUSTOM" },
            reviewRun: { repository: { userId: ownerUserId } },
            OR: [
                { feedback: { some: { userId: ownerUserId, kind: { in: ["TRUE_POSITIVE", "FALSE_POSITIVE", "FIX_ACCEPTED"] } } } },
                { fixes: { some: { status: "IMPLEMENTED" } } },
            ],
        },
        select: findingSelect(ownerUserId),
        take: MAX_FINDINGS,
    });
    return ruleFalseAlarmRates(rows.map(r => toMetricFinding(r as Row)), ruleIds);
}
