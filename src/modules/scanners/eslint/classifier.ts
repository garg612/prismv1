import { z } from "zod";
import type { EslintMLFeatures } from "./features";

/** One prediction of the ESLint surface classifier */
export const EslintPredictionSchema = z.object({
    probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
    ensemble_surface_probability: z.number().finite().min(0).max(1),
    threshold: z.number().finite().gt(0).lt(1),
    decision: z.string().transform(d => d.trim().toLowerCase()).pipe(z.enum(["surface", "suppress"])),
});
const BatchResponseSchema = z.object({ predictions: z.array(EslintPredictionSchema) });

export type EslintPrediction = z.infer<typeof EslintPredictionSchema>;

/** Every finding sent to the model gets exactly one result: a real prediction or an explicit error. */
export type EslintMLResult =
    | { findingId: string; ok: true; prediction: EslintPrediction; latencyMs: number }
    | { findingId: string; ok: false; error: string };

export const ESLINT_MODEL_NAME = "prism-eslint-ensemble";
/** The service does not report a version. This is the version of its published API. */
export const ESLINT_MODEL_VERSION = "prism-eslint-surface-classifier-1.0.0";

/** The service accepts at most this many findings per request */
const BATCH_SIZE = 100;
/** The service sleeps when idle; its first answer after that can take close to a minute. */
const TIMEOUT_MS = 90_000;

export function getEslintMLUrl(): string | null {
    const raw = (process.env.ESLINT_ML_SERVICE_URL || "").trim().replace(/\/+$/, "");
    if (!raw) return null;
    try {
        const url = new URL(raw);
        return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
    } catch {
        return null;
    }
}

async function predictBatch(url: string, batch: Array<{ findingId: string; features: EslintMLFeatures }>, fetchImpl: typeof fetch): Promise<EslintMLResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();
    try {
        const res = await fetchImpl(`${url}/predict/batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ findings: batch.map(b => b.features) }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const parsed = BatchResponseSchema.parse(await res.json());
        // Predictions carry no id: they are matched by position, so the count must be exact.
        if (parsed.predictions.length !== batch.length) {
            throw new Error(`Model answered ${parsed.predictions.length} predictions for ${batch.length} findings`);
        }
        for (const p of parsed.predictions) {
            // The decision must be the one the score and threshold imply; otherwise the answer cannot be trusted.
            if ((p.ensemble_surface_probability >= p.threshold) !== (p.decision === "surface")) {
                throw new Error("Model decision does not match its own score and threshold");
            }
        }
        const latencyMs = Date.now() - startedAt;
        return batch.map((b, i) => ({ findingId: b.findingId, ok: true as const, prediction: parsed.predictions[i], latencyMs }));
    } catch (err: any) {
        const reason = err?.name === "AbortError" ? "Request timed out" : err?.name === "ZodError" ? "Model response is not in the expected shape" : (err?.message || "Unknown ML service error");
        return batch.map(b => ({ findingId: b.findingId, ok: false as const, error: String(reason).slice(0, 500) }));
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Ask the ESLint triage model about each finding. Never throws: a missing endpoint, a timeout or a
 * malformed answer comes back as an explicit error for every finding it affects.
 */
export async function callEslintMLService(items: Array<{ findingId: string; features: EslintMLFeatures }>, fetchImpl: typeof fetch = fetch): Promise<EslintMLResult[]> {
    if (items.length === 0) return [];
    const url = getEslintMLUrl();
    if (!url) {
        return items.map(i => ({ findingId: i.findingId, ok: false as const, error: "ESLINT_ML_SERVICE_URL is not configured" }));
    }
    const batches: Array<typeof items> = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));
    return (await Promise.all(batches.map(batch => predictBatch(url, batch, fetchImpl)))).flat();
}
