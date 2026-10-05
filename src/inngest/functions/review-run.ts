import { selectFindingsForFix } from "@/modules/fix/lib/selection";
import { inngest } from "../client";
import { getDiff, upsertReviewComment, getTarballUrl, listChangedFiles, getFileCommitsSince } from "@/modules/github/lib/github";
import { retrieveContext } from "@/modules/ai/lib/rag";
import { generateText } from "ai";
import { getFixModelName, getReportModelName } from "@/lib/ai";
import prisma from "@/lib/db";
import { canCreateReview } from "@/modules/payment/lib/subscription";
import { requestScan } from "@/modules/runner/lib/client";
import { getEnabledScanners, ScannerConfigError } from "@/modules/scanners/registry";
import type { NormalizedFinding, ScanCallbackData, ScanEvaluation, ScannerAdapter } from "@/modules/scanners/types";
import type { ScannerId } from "@/modules/scanners/catalog";
import { parseDiffHunks, isInChangedLines } from "@/modules/review/lib/diff-hunks";
import { PipelineFailure } from "@/modules/review/lib/pipeline-failure";
import { assertTriageConfig, MLConfigError, TriageMode } from "@/modules/triage/lib/http-classifier";
import { getFinalDecision, POLICY_VERSION, TRIAGE_TAU_SURFACE, TRIAGE_TAU_SUPPRESS } from "@/modules/triage/lib/policy";
import type { TriageContext, TriageScore } from "@/modules/triage/lib/scoring";
import { Finding } from "@/generated/prisma/client";
import { Octokit } from "octokit";
import { NonRetriableError } from "inngest";
import { mapWithLimit } from "@/lib/concurrency";
import { isHolisticReviewEnabled } from "@/lib/feature-flags";
import { runLogicReview } from "@/modules/logic-review/lib/run";
import { recordLogicReview } from "@/modules/logic-review/lib/persist";
import { LOGIC_REVIEW_SOURCE } from "@/modules/logic-review/lib/schema";
import { loadRuleFalseAlarmRates } from "@/modules/metrics/lib/load-metrics";

/** Independent database / GitHub calls made side by side within one step */
const IO_CONCURRENCY = 8;
import { processFinding } from "./process-finding";
import { generateReport } from "./generate-report";
/** Persist what a scan callback proved. A failed or missing scan is recorded as such, with its reason. */
async function recordScanOutcome(scanRunId: string, scanner: ScannerAdapter, evaluation: ScanEvaluation) {
    if (evaluation.ok) {
        await prisma.scanRun.update({
            where: { id: scanRunId },
            data: {
                status: "COMPLETED",
                finishedAt: new Date(),
                scannedFiles: evaluation.scannedFiles,
                ...(evaluation.toolVersion ? { toolVersion: `${scanner.displayName.toLowerCase()} ${evaluation.toolVersion}` } : {}),
                ...(evaluation.toolWarnings.length > 0 ? { toolErrors: evaluation.toolWarnings as any } : {})
            }
        });
    } else {
        await prisma.scanRun.update({
            where: { id: scanRunId },
            data: {
                status: evaluation.jobStatus,
                finishedAt: new Date(),
                toolErrors: { code: evaluation.code, error: evaluation.error }
            }
        });
    }
}

async function resolveLatestRunState(pullRequestId: string, latestHeadSha: string) {
    const newerRun = await prisma.reviewRun.findFirst({
        where: { pullRequestId, headSha: latestHeadSha },
        orderBy: { updatedAt: 'desc' }
    });

    if (!newerRun) return { state: "processing" };

    if (newerRun.status === "COMPLETED") {
        const newerReview = await prisma.review.findFirst({
            where: { reviewRunId: newerRun.id }
        });
        if (newerReview) return { state: "ready", reviewText: newerReview.review };
        return { state: "processing" };
    }

    if (newerRun.status === "FAILED" || newerRun.status === "CANCELED") {
        return { state: "failed" };
    }

    return { state: "processing" };
}

export const reviewRunOrchestrator = inngest.createFunction({
    id: "review-run",
    concurrency: { limit: 5 },
    triggers: {
        event: "pr.review.requested"
    }
}, async ({ event, step }) => {
    if (process.env.PIPELINE_V2 !== "true") {
        return { success: true, skipped: true, reason: "PIPELINE_V2 disabled, using legacy review" };
    }

    const { owner, repo, prNumber, repositoryGithubId, headSha, action } = event.data;
    let reviewRunId: string | undefined;

    try {
        const data = await step.run("load-and-guard", async () => {
            const repository = await prisma.repository.findUnique({
                where: { githubId: BigInt(repositoryGithubId) },
                include: { user: { include: { accounts: { where: { providerId: "github" } } } } }
            });

            if (!repository) throw new NonRetriableError("Repository not found");

            const account = repository.user?.accounts[0];
            if (!account || !account.accessToken) throw new NonRetriableError("No github account/token found for user");

            const canReview = await canCreateReview(repository.userId, repository.id);
            if (!canReview) throw new NonRetriableError("Review limit reached for this repository");

            const octokit = new Octokit({ auth: account.accessToken });
            const { data: pr } = await octokit.rest.pulls.get({
                owner,
                repo,
                pull_number: prNumber
            });

            const pullRequest = await prisma.pullRequest.upsert({
                where: { repositoryId_number: { repositoryId: repository.id, number: prNumber } },
                update: {
                    title: pr.title,
                    url: pr.html_url,
                    authorLogin: pr.user?.login || "unknown",
                    headRef: pr.head.ref,
                    headRepoFullName: pr.head.repo?.full_name || `${owner}/${repo}`,
                    baseRef: pr.base.ref,
                    isFork: pr.head.repo?.fork || false,
                    isDraft: pr.draft || false,
                    state: pr.state,
                    latestHeadSha: headSha,
                    updatedAt: new Date()
                },
                create: {
                    repositoryId: repository.id,
                    number: prNumber,
                    title: pr.title,
                    url: pr.html_url,
                    authorLogin: pr.user?.login || "unknown",
                    headRef: pr.head.ref,
                    headRepoFullName: pr.head.repo?.full_name || `${owner}/${repo}`,
                    baseRef: pr.base.ref,
                    isFork: pr.head.repo?.fork || false,
                    isDraft: pr.draft || false,
                    state: pr.state,
                    latestHeadSha: headSha
                }
            });

            // Avoid race conditions
            const isManualRerun = action.toUpperCase() === "MANUAL_RERUN";
            const maxAttemptAgg = await prisma.reviewRun.aggregate({
                where: { pullRequestId: pullRequest.id, headSha: headSha },
                _max: { attempt: true }
            });
            const currentMax = maxAttemptAgg._max.attempt || 0;

            if (currentMax > 0 && !isManualRerun) {
                throw new Error("DUPLICATE_RUN");
            }

            const attempt = currentMax + 1;

            let reviewRun;
            try {
                reviewRun = await prisma.reviewRun.create({
                    data: {
                        pullRequestId: pullRequest.id,
                        repositoryId: repository.id,
                        headSha: headSha,
                        baseSha: pr.base.sha,
                        attempt: attempt,
                        trigger: (["OPENED", "SYNCHRONIZE", "POST_APPLY_VERIFY"].includes(action.toUpperCase())) ? (action.toUpperCase() as any) : "OPENED",
                        status: "QUEUED",
                        startedAt: new Date(),
                        configSnapshot: {
                            pipelineVersion: "v2",
                            llmProvider: "groq",
                            fixModel: getFixModelName(),
                            reportModel: getReportModelName(),
                            featureFlags: { PIPELINE_V2: true }
                        }
                    }
                });
             
            } catch (err: any) {
                if (err.code === "P2002") {
                    throw new Error("DUPLICATE_RUN");
                }
                throw err;
            }

            await prisma.reviewRun.updateMany({
                where: {
                    pullRequestId: pullRequest.id,
                    id: { not: reviewRun.id },
                    status: { in: ["QUEUED", "SCANNING", "CLASSIFYING", "FIXING", "VALIDATING", "REPORTING", "AWAITING_APPROVAL"] }
                },
                data: {
                    status: "SUPERSEDED",
                    supersededById: reviewRun.id,
                    updatedAt: new Date()
                }
            });

            return {
                userId: repository.userId,
                reviewRunId: reviewRun.id,
                pullRequestId: pullRequest.id,
                repositoryId: repository.id,
                baseSha: pr.base.sha as string,
                title: pr.title,
                description: pr.body || "",
            };
        });

        reviewRunId = data.reviewRunId;

        // A newer commit supersedes this run. Once that happens it must stop: it may not scan,
        // classify, generate fixes or change its own status again.
        const SUPERSEDED_RESULT = { success: true, skipped: true, reason: "Superseded by a newer commit" };
        const isSuperseded = (checkpoint: string) => step.run(`check-superseded-${checkpoint}`, async () => {
            const run = await prisma.reviewRun.findUnique({ where: { id: data.reviewRunId }, select: { status: true } });
            return run?.status === "SUPERSEDED";
        });
        // Moves the run forward only if it is still current. Returns false once it has been
        // superseded (or otherwise ended), so the status change doubles as that check.
        const advanceTo = (status: "FIXING" | "REPORTING"): Promise<boolean> => step.run(`update-status-${status.toLowerCase()}`, async () => {
            const updated = await prisma.reviewRun.updateMany({
                where: { id: data.reviewRunId, status: { notIn: ["SUPERSEDED", "FAILED", "CANCELED"] } },
                data: { status }
            });
            return updated.count > 0;
        });

        // Fail closed on configuration: never start a run that would need invented ML defaults.
        let triageMode: TriageMode;
        try {
            triageMode = assertTriageConfig();
        } catch (e: any) {
            if (e instanceof MLConfigError) throw new PipelineFailure("TRIAGE", "ML_CONFIG_INVALID", e.message);
            throw e;
        }

        // ------------- STAGE 3 SCANNING PIPELINE -------------
        
        const repository = await step.run("fetch-repo-account", async () => {
            return await prisma.repository.findUnique({
                where: { id: data.repositoryId },
                include: { user: { include: { accounts: { where: { providerId: "github" } } } } }
            });
        });
        const account = repository?.user?.accounts[0];
        if (!account || !account.accessToken) throw new NonRetriableError("GitHub token unavailable");

        const changedFiles = await step.run("list-changed-files", async () => {
            return await listChangedFiles(account.accessToken!, owner, repo, prNumber);
        });

        const prModel = await step.run("get-pr", async () => {
            return await prisma.pullRequest.findUnique({ where: { id: data.pullRequestId } });
        });
        const headOwner = prModel?.headRepoFullName.split('/')[0] || owner;

        // Base scan is required to tell new findings from pre-existing ones.
        if (!prModel?.baseRef) {
            throw new PipelineFailure("SCAN", "BASE_REF_UNKNOWN", "Pull request base ref is unknown; cannot establish a baseline");
        }

        let scanners: ScannerAdapter[];
        try {
            scanners = getEnabledScanners();
        } catch (e: any) {
            if (e instanceof ScannerConfigError) throw new PipelineFailure("SCAN", "SCANNER_CONFIG_INVALID", e.message);
            throw e;
        }

        // One scanner scanning one commit. Step ids carry the scanner id so several scanners can run in one review.
        const runScan = async (scanner: ScannerAdapter, kind: "HEAD" | "BASE", refOwner: string, ref: string) => {
            const key = `${kind.toLowerCase()}-scan-${scanner.id.toLowerCase()}`;

            const scanRun = await step.run(`create-${key}`, async () => {
                return await prisma.scanRun.create({
                    data: {
                        reviewRunId: data.reviewRunId,
                        kind,
                        source: scanner.id,
                        rulesetId: scanner.getRulesetId(),
                        status: "PENDING"
                    }
                });
            });

            await step.run(`dispatch-${key}`, async () => {
                const tarballUrl = await getTarballUrl(account.accessToken!, refOwner, repo, ref);
                await requestScan(scanRun.id, tarballUrl, changedFiles, scanner.id);
                await prisma.scanRun.update({ where: { id: scanRun.id }, data: { status: "RUNNING", startedAt: new Date() } });
            });

            const scanEvent = await step.waitForEvent(`wait-for-${key}`, {
                event: "runner.scan.completed",
                if: `async.data.scanRunId == '${scanRun.id}'`,
                timeout: "5m"
            });

            const evaluation: ScanEvaluation = await step.run(`process-${key}`, async () => {
                const result = scanner.evaluateScan((scanEvent?.data ?? null) as ScanCallbackData | null);
                await recordScanOutcome(scanRun.id, scanner, result);
                return result;
            });

            return { scanRunId: scanRun.id as string, evaluation, repoLOC: (scanEvent?.data?.repoLOC ?? null) as number | null };
        };

        // The diff does not depend on the scans, so it is fetched while they run.
        const diffStep: Promise<{ diff: string }> = step.run("fetch-pr-data", async () => {
            const diffData = await getDiff(account.accessToken!, owner, repo, prNumber);
            return { diff: diffData.diff };
        });

        type ScannedFinding = NormalizedFinding & { source: ScannerId; scanRunId: string };
        const headFindings: ScannedFinding[] = [];
        const baseFindings: ScannedFinding[] = [];
        let repoLOC: number | null = null;

        for (const scanner of scanners) {
            // Fail closed: a HEAD scan that timed out, failed or reported tool errors ends the run.
            // It is never converted into an empty finding list. Always this run's own commit,
            // never "whatever is newest on the PR".
            // The base commit recorded for this run; the branch name can move while the run is in flight.
            // HEAD and BASE are independent, so they are scanned side by side.
            const [head, base] = await Promise.all([
                runScan(scanner, "HEAD", headOwner, headSha),
                runScan(scanner, "BASE", owner, data.baseSha || prModel.baseRef),
            ]);
            if (!head.evaluation.ok) {
                throw new PipelineFailure("SCAN", `HEAD_${head.evaluation.code}`, `${scanner.displayName} HEAD scan did not complete: ${head.evaluation.error}`);
            }

            // Fail closed: without a baseline every finding would be labelled "new". Stop instead.
            if (!base.evaluation.ok) {
                throw new PipelineFailure(
                    "SCAN",
                    `BASE_${base.evaluation.code}`,
                    `${scanner.displayName} BASE scan did not complete, so new findings cannot be told apart from pre-existing ones: ${base.evaluation.error}`
                );
            }

            headFindings.push(...head.evaluation.findings.map(f => ({ ...f, source: scanner.id, scanRunId: head.scanRunId })));
            baseFindings.push(...base.evaluation.findings.map(f => ({ ...f, source: scanner.id, scanRunId: base.scanRunId })));
            repoLOC = repoLOC ?? head.repoLOC;
        }

        const { diff } = await diffStep;

        if (await isSuperseded("after-base-scan")) return SUPERSEDED_RESULT;

        const persistedFindings = await step.run("persist-findings", async () => {
            const fileHunks = parseDiffHunks(diff);

            const baseFindingsMap = new Map<string, number>();
            // The same fingerprint from two scanners is two different findings.
            const occurrenceKey = (f: ScannedFinding) => `${f.source}:${f.fingerprint}`;
            for (const f of baseFindings) {
                baseFindingsMap.set(occurrenceKey(f), (baseFindingsMap.get(occurrenceKey(f)) || 0) + 1);
            }

            const headFindingsMap = new Map<string, number>();
            for (const finding of headFindings) {
                headFindingsMap.set(occurrenceKey(finding), (headFindingsMap.get(occurrenceKey(finding)) || 0) + 1);
                // Assign occurrence starting from 1
                (finding as any).occurrence = headFindingsMap.get(occurrenceKey(finding));
            }

            const dbFindings = await mapWithLimit(headFindings, IO_CONCURRENCY, async (finding) => {
                const occurrence = (finding as any).occurrence || 1;
                const baseCount = baseFindingsMap.get(occurrenceKey(finding)) || 0;
                const isPreexisting = occurrence <= baseCount;

                const inChangedLines = isInChangedLines(fileHunks, finding.filePath, finding.startLine, finding.endLine || finding.startLine);

                const dbF = await prisma.finding.upsert({
                    where: { 
                        reviewRunId_source_fingerprint_occurrence: {
                            reviewRunId: data.reviewRunId,
                            source: finding.source,
                            fingerprint: finding.fingerprint,
                            occurrence: occurrence
                        }
                    },
                    update: { isPreexisting, inChangedLines, metadata: (finding as any).metadata },
                    create: {
                        reviewRunId: data.reviewRunId,
                        scanRunId: finding.scanRunId,
                        source: finding.source,
                        ruleId: finding.ruleId,
                        ruleName: finding.ruleName,
                        category: finding.category,
                        severity: finding.severity,
                        sourceSeverity: finding.sourceSeverity,
                        message: finding.message,
                        filePath: finding.filePath,
                        startLine: finding.startLine,
                        endLine: finding.endLine || finding.startLine,
                        startCol: finding.startCol,
                        endCol: finding.endCol,
                        codeSnippet: finding.codeSnippet,
                        fingerprint: finding.fingerprint,
                        occurrence: occurrence,
                        isPreexisting,
                        inChangedLines,
                        status: "DETECTED",
                        metadata: (finding as any).metadata
                    }
                });
                return dbF;
            });
            
            await prisma.reviewRun.update({
                where: { id: data.reviewRunId },
                data: { totalFindings: headFindings.length }
            });
            
            return { dbFindings, totalChangedLines: Array.from(fileHunks.values()).reduce((acc, hunks) => acc + hunks.reduce((sum, h) => sum + (h.end - h.start + 1), 0), 0) };
        });
        
        // Logic review: an AI pass over the diff for bugs no scanner looks for. It is told what the
        // scanners found so the two never report the same thing, and it runs alongside triage and
        // fixing so it adds no time. It is advisory: if it fails, that is recorded and shown, and the
        // rest of the review carries on.
        // The step always runs and reports whether a review happened, so a skipped review is visible
        // in the trace. The setting is read at this moment, not taken from an earlier step.
        const logicReviewStep: Promise<{ skipped?: boolean; ok?: boolean; issues?: number; reviewedFiles?: number }> =
            step.run("logic-review", async () => {
                const settings = await prisma.repository.findUnique({ where: { id: data.repositoryId }, select: { holisticReview: true } });
                if (!isHolisticReviewEnabled(!!settings?.holisticReview)) {
                    return { skipped: true };
                }
                const startedAt = new Date();
                const result = await runLogicReview({
                    diff,
                    title: data.title,
                    description: data.description,
                    toolFindings: headFindings.map(f => ({
                        filePath: f.filePath,
                        startLine: f.startLine,
                        endLine: f.endLine || f.startLine,
                        ruleId: f.ruleId,
                        message: f.message
                    }))
                });
                const stored = await recordLogicReview(data.reviewRunId, result, startedAt);
                return { ok: result.ok, issues: stored.issues, reviewedFiles: result.coverage.reviewedFiles.length };
            });

        await step.run("ml-triage", async () => {
            const { dbFindings, totalChangedLines } = persistedFindings;
            const mode = triageMode;

            // 1. What the models may need about this review
            const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
            const fileHunks = parseDiffHunks(diff);
            // Only this repository owner's own decisions, counted once per distinct issue, and only
            // when enough of them exist. Another account's feedback never reaches a model input.
            const ruleFalseAlarmRates = repository?.userId
                ? await loadRuleFalseAlarmRates(repository.userId, Array.from(new Set(dbFindings.map(f => f.ruleId))))
                : new Map<string, number | null>();

            // 2. Ask each scanner's own model about that scanner's findings. Every finding comes back
            //    as a score or as an explicit reason there is none.
            const scoreByFinding = new Map<string, TriageScore>();
            if (mode !== 'policy') {
                for (const scanner of scanners) {
                    const own = dbFindings.filter(f => f.source === scanner.id) as any as Finding[];
                    if (own.length === 0) continue;
                    const context: TriageContext = {
                        fileHunks,
                        totalChangedLines,
                        baseFindings: baseFindings.filter(f => f.source === scanner.id).map(f => ({ ruleId: f.ruleId, filePath: f.filePath })),
                        ruleFalseAlarmRates,
                        getFileChurn: async filePath => {
                            try {
                                return (await getFileCommitsSince(account.accessToken!, owner, repo, filePath, ninetyDaysAgo)).length;
                            } catch {
                                return null;
                            }
                        },
                        // repoLOC was measured by the runner during the HEAD scan
                        repoFindingDensity: repoLOC ? (headFindings.filter(f => f.source === scanner.id).length / repoLOC) * 1000 : null,
                    };
                    for (const score of await scanner.scoreFindings(own, context)) scoreByFinding.set(score.findingId, score);
                }
            }

            const summary = { mode, total: dbFindings.length, modelScored: 0, featuresUnavailable: 0, mlUnavailable: 0 };

            await mapWithLimit(dbFindings, IO_CONCURRENCY, async (f) => {
                const answer = scoreByFinding.get(f.id);
                const scored = answer && answer.ok ? answer : null;
                const features = answer ? answer.features : null;

                // The mode asked for a model score and there is none: record why, never substitute one.
                let fallback: { code: string; text: string } | null = null;
                if (mode !== 'policy' && !scored) {
                    if (answer && !answer.ok) {
                        fallback = { code: answer.code, text: answer.error };
                        if (answer.code === 'ML_FEATURES_UNAVAILABLE') summary.featuresUnavailable++;
                        else summary.mlUnavailable++;
                    } else {
                        fallback = { code: 'ML_UNAVAILABLE', text: 'No triage model answered for this finding' };
                        summary.mlUnavailable++;
                    }
                }

                // Each model is measured against its own bar.
                const showFrom = scored ? scored.showFrom : TRIAGE_TAU_SURFACE;
                const hideBelow = scored ? scored.hideBelow : TRIAGE_TAU_SUPPRESS;
                const { finalDecision, decisionSource } = getFinalDecision(f as any as Finding, mode, scored?.score, { showFrom, hideBelow });

                if (scored) {
                    summary.modelScored++;
                    const isShadow = mode === 'shadow';
                    await prisma.findingClassification.create({
                        data: {
                            findingId: f.id,
                            modelName: scored.modelName,
                            modelVersion: scored.modelVersion,
                            policyVersion: POLICY_VERSION,
                            score: scored.score,
                            modelDecision: scored.modelDecision,
                            uncertain: scored.score > hideBelow && scored.score < showFrom,
                            finalDecision: finalDecision,
                            decisionSource: isShadow ? 'MODEL' : decisionSource,
                            thresholdHigh: showFrom,
                            thresholdLow: hideBelow,
                            isShadow: isShadow,
                            latencyMs: scored.latencyMs,
                            featureSnapshot: features as any,
                        }
                    });
                }

                // The policy decision is recorded whenever it is what actually routed the finding
                // (policy mode, shadow mode, or an explicit fallback from the model).
                if (!scored || mode === 'shadow') {
                    await prisma.findingClassification.create({
                        data: {
                            findingId: f.id,
                            modelName: "policy-v0",
                            modelVersion: "N/A",
                            policyVersion: POLICY_VERSION,
                            score: 0, // column is non-nullable; modelName "policy-v0" marks this as not a model score
                            modelDecision: finalDecision,
                            uncertain: false,
                            finalDecision: finalDecision,
                            decisionSource: fallback ? 'POLICY_FALLBACK' : decisionSource,
                            thresholdHigh: showFrom,
                            thresholdLow: hideBelow,
                            reasonCodes: fallback ? [fallback.code] : [],
                            reasonText: fallback ? fallback.text : null,
                            isShadow: false,
                            featureSnapshot: scored ? undefined : (features as any) ?? undefined
                        }
                    });
                }

                // Update final state of finding
                await prisma.finding.update({
                    where: { id: f.id },
                    data: { triageDecision: finalDecision }
                });
            });

            // Keep the run's stored counters equal to the rows they summarise.
            const [surfacedCount, suppressedCount] = await Promise.all([
                prisma.finding.count({ where: { reviewRunId: data.reviewRunId, source: { not: LOGIC_REVIEW_SOURCE }, triageDecision: "SURFACE" } }),
                prisma.finding.count({ where: { reviewRunId: data.reviewRunId, source: { not: LOGIC_REVIEW_SOURCE }, triageDecision: "SUPPRESS" } }),
            ]);
            await prisma.reviewRun.update({ where: { id: data.reviewRunId }, data: { surfacedCount, suppressedCount } });

            return summary;
        });

        // ------------- END STAGE 3 SCANNING PIPELINE -------------


        // ------------- STAGE 6 FIX GENERATION AND VALIDATION -------------

        const surfacedFindings = await step.run("get-surfaced-findings", async () => {
            return await prisma.finding.findMany({
                where: { reviewRunId: data.reviewRunId, triageDecision: "SURFACE" }
            });
        });

        if (!(await advanceTo("FIXING"))) return SUPERSEDED_RESULT;

        // Fan-out to process-finding for each surfaced finding
        if (surfacedFindings.length > 0 && action.toUpperCase() !== "POST_APPLY_VERIFY") {
            // Every shown finding gets a fix in this review (see selectFindingsForFix).
            const findingsToProcess = selectFindingsForFix(surfacedFindings as any[]);
            await Promise.all(
                findingsToProcess.map(f => step.invoke(`process-finding-${f.id}`, {
                    function: processFinding,
                    data: { findingId: f.id, reviewRunId: data.reviewRunId }
                }))
            );
        }

        // The report includes the logic review, so it must be finished (or have failed) first.
        await logicReviewStep;

        if (!(await advanceTo("REPORTING"))) return SUPERSEDED_RESULT;

        // Fan-in to generate-report
        await step.invoke("generate-report", {
            function: generateReport,
            data: { reviewRunId: data.reviewRunId }
        });

        const reviewText = await step.run("fetch-report", async () => {
            const review = await prisma.review.findUnique({ where: { reviewRunId: data.reviewRunId } });
            return review?.review || "Automated code review completed.";
        });

        await step.run("publish-comment", async () => {
            // Pre-publish check: Ensure we are still the latest run for this PR
            const prPre = await prisma.pullRequest.findUnique({ where: { id: data.pullRequestId } });
            if (prPre?.latestHeadSha !== headSha) {
                return { skipped: true, reason: "Stale before publish" };
            }

            const repository = await prisma.repository.findUnique({
                where: { id: data.repositoryId },
                include: { user: { include: { accounts: { where: { providerId: "github" } } } } }
            });
            const account = repository?.user?.accounts[0];
            if (!account || !account.accessToken) throw new NonRetriableError("GitHub token unavailable");

            // External GitHub API Call
            await upsertReviewComment(account.accessToken, owner, repo, prNumber, reviewText);

            // Post-publish reconciliation (Option D)
            const prPost = await prisma.pullRequest.findUnique({ where: { id: data.pullRequestId } });
            if (prPost?.latestHeadSha !== headSha && prPost?.latestHeadSha) {
                const resolution = await resolveLatestRunState(data.pullRequestId, prPost.latestHeadSha);
                
                if (resolution.state === "ready" && resolution.reviewText) {
                    await upsertReviewComment(account.accessToken, owner, repo, prNumber, resolution.reviewText);
                } else if (resolution.state === "processing") {
                    await upsertReviewComment(account.accessToken, owner, repo, prNumber, "⚠️ **Notice:** PRism is analyzing a newer commit for this Pull Request.");
                } else if (resolution.state === "failed") {
                    await upsertReviewComment(account.accessToken, owner, repo, prNumber, "⚠️ **Notice:** PRism review for this commit was superseded by a newer commit, but the newer review could not be completed.");
                }
            }
        });

        await step.run("finalize-run", async () => {
            const readyFixesCount = await prisma.suggestedFix.count({
                where: { reviewRunId: data.reviewRunId, status: "READY" }
            });
            const finalStatus = readyFixesCount > 0 ? "AWAITING_APPROVAL" : "COMPLETED";

            await prisma.$transaction(async (tx) => {
                // Atomic condition: only update and bill if billedAt is currently null
                const updated = await tx.reviewRun.updateMany({
                    where: { 
                        id: data.reviewRunId, 
                        billedAt: null,
                        status: { notIn: ["SUPERSEDED", "FAILED", "CANCELED"] }
                    },
                    data: { 
                        billedAt: new Date(), 
                        status: finalStatus, 
                        finishedAt: new Date() 
                    }
                });

                if (updated.count > 0) {
                    // We atomically secured the billing right. Update the user's usage counts.
                    let usage = await tx.userUsage.findUnique({ where: { userId: data.userId } });
                    if (!usage) {
                        usage = await tx.userUsage.create({ data: { userId: data.userId, repositoriesCount: 0, reviewsCounts: {} } });
                    }
                    const reviewCounts = (usage.reviewsCounts || {}) as Record<string, number>;
                    reviewCounts[data.repositoryId] = (reviewCounts[data.repositoryId] || 0) + 1;
                    
                    await tx.userUsage.update({
                        where: { userId: data.userId },
                        data: { reviewsCounts: reviewCounts }
                    });
                } else {
                    // We lost the race (already billed, or run was superseded/failed).
                    // Ensure status transitions to finalStatus if it is eligible, without double billing.
                    await tx.reviewRun.updateMany({
                        where: { 
                            id: data.reviewRunId,
                            status: { notIn: ["SUPERSEDED", "FAILED", "CANCELED"] }
                        },
                        data: { 
                            status: finalStatus, 
                            finishedAt: new Date() 
                        }
                    });
                }
            });
        });

        return { success: true };
     
    } catch (err: any) {
        if (err.message === "DUPLICATE_RUN") {
            return { success: true, skipped: true, reason: "Duplicate run avoided" };
        }

        const failure = err instanceof PipelineFailure ? err : null;

        if (reviewRunId) {
            await step.run("mark-failed", async () => {
                await prisma.reviewRun.updateMany({
                    where: { id: reviewRunId, status: { not: "SUPERSEDED" } },
                    data: {
                        status: "FAILED",
                        failureMessage: err.message || "Unknown error",
                        failureStage: failure?.stage ?? "WORKFLOW",
                        failureCode: failure?.code ?? null,
                        finishedAt: new Date()
                    }
                });
            });

            // Make the failure visible on the PR so an older "clean" comment is not read as current.
            if (failure) {
                await step.run("publish-failure-notice", async () => {
                    try {
                        const run = await prisma.reviewRun.findUnique({
                            where: { id: reviewRunId },
                            include: {
                                pullRequest: true,
                                repository: { include: { user: { include: { accounts: { where: { providerId: "github" } } } } } }
                            }
                        });
                        const token = run?.repository.user?.accounts[0]?.accessToken;
                        if (!run || !token) return { published: false, reason: "No token" };
                        if (run.status !== "FAILED" || run.pullRequest.latestHeadSha !== headSha) {
                            return { published: false, reason: "Not the latest run" };
                        }

                        await upsertReviewComment(
                            token, owner, repo, prNumber,
                            `⚠️ **Analysis incomplete for commit \`${headSha.substring(0, 7)}\`** (\`${failure.code}\`).\n\n` +
                            `PRism could not complete its scan of this commit, so there is no result for it. ` +
                            `This is not a clean result, and earlier results do not apply to this commit.`
                        );
                        return { published: true };
                    } catch (noticeErr: any) {
                        console.error("Failed to publish failure notice", noticeErr);
                        return { published: false, reason: noticeErr?.message };
                    }
                });
            }
        }
        throw err;
    }
});
