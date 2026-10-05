import type { Finding } from "@/generated/prisma/client";
import { mapWithLimit } from "@/lib/concurrency";
import type { Hunk } from "@/modules/review/lib/diff-hunks";
import { buildEslintFeatures } from "@/modules/scanners/eslint/features";
import { callEslintMLService, ESLINT_MODEL_NAME, ESLINT_MODEL_VERSION } from "@/modules/scanners/eslint/classifier";
import { buildMLFeatures, MLFeaturePayload } from "./features";
import { callMLService } from "./http-classifier";
import { TRIAGE_TAU_SUPPRESS, TRIAGE_TAU_SURFACE } from "./policy";

/**
 * What a scanner's triage model said about one finding. Each scanner has its own model with its
 * own inputs and its own bar, so the bar travels with the score:
 *  - at or above `showFrom` the finding is shown
 *  - at or below `hideBelow` it is noise
 *  - a model with a single threshold reports the same number for both
 */
export type TriageScore =
    | {
        findingId: string;
        ok: true;
        score: number;
        modelDecision: "SURFACE" | "SUPPRESS";
        showFrom: number;
        hideBelow: number;
        modelName: string;
        modelVersion: string;
        latencyMs: number | null;
        features: unknown;
    }
    | {
        findingId: string;
        ok: false;
        /** ML_FEATURES_UNAVAILABLE: an input could not be measured. ML_UNAVAILABLE: the model gave no usable answer. */
        code: "ML_FEATURES_UNAVAILABLE" | "ML_UNAVAILABLE";
        error: string;
        features: unknown | null;
    };

/** Everything any scanner's model may need about the review the findings belong to */
export interface TriageContext {
    /** New-side line ranges the pull request changes, per file */
    fileHunks: Map<string, Hunk[]>;
    totalChangedLines: number;
    /** This scanner's findings on the base commit */
    baseFindings: Array<{ ruleId: string; filePath: string }>;
    /** False-alarm rate per rule from the repository owner's own decisions; null without enough of them */
    ruleFalseAlarmRates: Map<string, number | null>;
    /** Commits that touched a file in the last 90 days; null when it could not be read */
    getFileChurn(filePath: string): Promise<number | null>;
    /** Scanner findings per 1000 lines of code in the repository; null when the size is unknown */
    repoFindingDensity: number | null;
}

export type ScoreFindings = (findings: Finding[], ctx: TriageContext) => Promise<TriageScore[]>;

const FEATURES_UNAVAILABLE = "Required model features could not be measured for this finding";
const NO_RESULT = "ML service returned no result for this finding";

/** Semgrep findings: the structural-features ensemble behind ML_SERVICE_URL. */
export const scoreSemgrepFindings: ScoreFindings = async (findings, ctx) => {
    const churn = new Map<string, number | null>();
    await mapWithLimit(Array.from(new Set(findings.map(f => f.filePath))), 8, async filePath => {
        churn.set(filePath, await ctx.getFileChurn(filePath));
    });

    const features = new Map<string, MLFeaturePayload | null>(findings.map(f => [
        f.id,
        buildMLFeatures(f, ctx.totalChangedLines, ctx.ruleFalseAlarmRates.get(f.ruleId) ?? null, churn.get(f.filePath) ?? null, ctx.repoFindingDensity),
    ]));
    const requested = Array.from(features.values()).filter((f): f is MLFeaturePayload => f !== null);
    const answers = new Map((await callMLService(requested)).map(r => [r.finding_id, r]));

    return findings.map((f): TriageScore => {
        const payload = features.get(f.id) ?? null;
        if (!payload) return { findingId: f.id, ok: false, code: "ML_FEATURES_UNAVAILABLE", error: FEATURES_UNAVAILABLE, features: null };
        const answer = answers.get(f.id);
        if (!answer || !answer.ok) return { findingId: f.id, ok: false, code: "ML_UNAVAILABLE", error: answer ? answer.error : NO_RESULT, features: payload };
        return {
            findingId: f.id, ok: true,
            score: answer.response.risk_score,
            modelDecision: answer.response.decision,
            showFrom: TRIAGE_TAU_SURFACE,
            hideBelow: TRIAGE_TAU_SUPPRESS,
            modelName: "prism-exp2-ensemble",
            modelVersion: answer.response.model_version,
            latencyMs: answer.latencyMs,
            features: payload,
        };
    });
};

/** ESLint findings: the surface classifier behind ESLINT_ML_SERVICE_URL. It has one threshold, which it reports with every score. */
export const scoreEslintFindings: ScoreFindings = async (findings, ctx) => {
    const featureContext = {
        fileHunks: ctx.fileHunks,
        totalChangedLines: ctx.totalChangedLines,
        headFindings: findings.map(f => ({ id: f.id, ruleId: f.ruleId, filePath: f.filePath, startLine: f.startLine, startCol: f.startCol })),
        baseFindings: ctx.baseFindings,
    };
    const features = new Map(findings.map(f => [f.id, buildEslintFeatures(f, featureContext)]));
    const requested = findings.flatMap(f => {
        const payload = features.get(f.id);
        return payload ? [{ findingId: f.id, features: payload }] : [];
    });
    const answers = new Map((await callEslintMLService(requested)).map(r => [r.findingId, r]));

    return findings.map((f): TriageScore => {
        const payload = features.get(f.id) ?? null;
        if (!payload) return { findingId: f.id, ok: false, code: "ML_FEATURES_UNAVAILABLE", error: FEATURES_UNAVAILABLE, features: null };
        const answer = answers.get(f.id);
        if (!answer || !answer.ok) return { findingId: f.id, ok: false, code: "ML_UNAVAILABLE", error: answer ? answer.error : NO_RESULT, features: payload };
        const { prediction } = answer;
        return {
            findingId: f.id, ok: true,
            score: prediction.ensemble_surface_probability,
            modelDecision: prediction.decision === "surface" ? "SURFACE" : "SUPPRESS",
            showFrom: prediction.threshold,
            hideBelow: prediction.threshold,
            modelName: ESLINT_MODEL_NAME,
            modelVersion: ESLINT_MODEL_VERSION,
            latencyMs: answer.latencyMs,
            features: { ...payload, component_probabilities: prediction.probabilities },
        };
    });
};
