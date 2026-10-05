import crypto from 'crypto';
import { MLFeaturePayload } from './features';
import { z } from 'zod';

export const MLComponentScoresSchema = z.object({
    lr: z.number().min(0).max(1),
    rf: z.number().min(0).max(1),
    xgb: z.number().min(0).max(1)
});

export const MLResponseSchema = z.object({
    finding_id: z.string().min(1),
    risk_score: z.number().finite().min(0).max(1),
    // The deployed service answers "SURFACE" or "FILTER"; "FILTER" is its word for SUPPRESS.
    decision: z.enum(["SURFACE", "SUPPRESS", "FILTER"]).transform(d => (d === "FILTER" ? "SUPPRESS" : d)),
    threshold: z.number().finite(),
    model_version: z.string(),
    dataset_version: z.string(),
    feature_version: z.string(),
    component_scores: MLComponentScoresSchema
});

export type MLResponse = z.infer<typeof MLResponseSchema>;

export type TriageMode = 'policy' | 'shadow' | 'model';

export class MLConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MLConfigError';
    }
}

export interface MLConfig {
    url: string;
    secret: string;
    acceptedModelVersions: string[];
}

/** Every finding sent to the model gets exactly one result: a real prediction or an explicit error. */
export type MLCallResult =
    | { finding_id: string; ok: true; response: MLResponse; latencyMs: number }
    | { finding_id: string; ok: false; error: string };

const DEFAULT_ACCEPTED_MODEL_VERSIONS = 'prism-exp2-ensemble-v1.0';

export function resolveTriageMode(): TriageMode {
    const raw = (process.env.TRIAGE_MODE || 'policy').trim();
    if (raw === 'policy' || raw === 'shadow' || raw === 'model') return raw;
    throw new MLConfigError(`TRIAGE_MODE must be one of policy|shadow|model, got ${JSON.stringify(raw)}`);
}

/**
 * Required ML configuration. There are no defaults for the endpoint or the signing
 * secret: a missing value is a deployment error, not something to paper over.
 */
export function getMLConfig(): MLConfig {
    const url = (process.env.ML_SERVICE_URL || '').trim();
    const secret = (process.env.ML_HMAC_SECRET || '').trim();

    const missing: string[] = [];
    if (!url) missing.push('ML_SERVICE_URL');
    if (!secret) missing.push('ML_HMAC_SECRET');
    if (missing.length > 0) {
        throw new MLConfigError(`Missing required ML configuration: ${missing.join(', ')}`);
    }

    try {
        new URL(url);
    } catch {
        throw new MLConfigError('ML_SERVICE_URL is not a valid URL');
    }

    const acceptedModelVersions = (process.env.ML_ACCEPTED_MODEL_VERSIONS || DEFAULT_ACCEPTED_MODEL_VERSIONS)
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);

    return { url, secret, acceptedModelVersions };
}

/** Validate triage configuration for the current mode. Throws MLConfigError if ML is required but not configured. */
export function assertTriageConfig(): TriageMode {
    const mode = resolveTriageMode();
    if (mode !== 'policy') getMLConfig();
    return mode;
}

export async function callMLService(features: MLFeaturePayload[]): Promise<MLCallResult[]> {
    if (features.length === 0) return [];

    const { url, secret, acceptedModelVersions } = getMLConfig();

    const results: MLCallResult[] = [];

    // The deployed endpoint takes one finding per request; run them concurrently in batches of 50.
    const BATCH_SIZE = 50;
    for (let i = 0; i < features.length; i += BATCH_SIZE) {
        const batch = features.slice(i, i + BATCH_SIZE);

        const batchPromises = batch.map(async (feature): Promise<MLCallResult> => {
            const bodyStr = JSON.stringify(feature);
            const t = Date.now().toString();
            const hmac = crypto.createHmac('sha256', secret).update(`${t}.${bodyStr}`).digest('hex');
            const signature = `t=${t},v1=${hmac}`;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout — Render free tier cold start can take up to 50s
            const startedAt = Date.now();

            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-PRism-Signature': signature
                    },
                    body: bodyStr,
                    signal: controller.signal
                });

                if (!res.ok) {
                    throw new Error(`HTTP error ${res.status}`);
                }

                const json = await res.json();
                const parsed = MLResponseSchema.parse(json);

                if (parsed.finding_id !== feature.finding_id) {
                    throw new Error(`Response is for a different finding (${parsed.finding_id})`);
                }

                if (!acceptedModelVersions.includes(parsed.model_version)) {
                    throw new Error(`Unsupported model version: ${parsed.model_version}`);
                }

                const expectedFeatureVersion = 'structured-plus-code-tfidf-sanitized-v1';
                if (parsed.feature_version !== expectedFeatureVersion) {
                    // Log a warning but do NOT reject — the live service may report a different version
                    console.warn(`ML feature_version mismatch: expected ${expectedFeatureVersion}, got ${parsed.feature_version} for finding ${feature.finding_id}`);
                }

                return { finding_id: feature.finding_id, ok: true, response: parsed, latencyMs: Date.now() - startedAt };
            } catch (err: any) {
                console.error("ML service error for finding", feature.finding_id, err);
                const reason = err?.name === 'AbortError' ? 'Request timed out' : (err?.message || 'Unknown ML service error');
                return { finding_id: feature.finding_id, ok: false, error: String(reason).slice(0, 500) };
            } finally {
                clearTimeout(timeout);
            }
        });

        results.push(...await Promise.all(batchPromises));
    }

    return results;
}
