/**
 * Stage 10: Structured Observability Logger
 * 
 * Provides safe structured logging for the PRism pipeline.
 * NEVER logs: code snippets, patches, tokens, secrets, complete tool output.
 * ALWAYS logs: reviewRunId, repositoryId, PR number, headSha, stage, status, durationMs, error.
 */

export interface PipelineLogContext {
    reviewRunId?: string;
    repositoryId?: string;
    prNumber?: number;
    headSha?: string;
    stage: string;
    status: 'STARTED' | 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'SKIPPED';
    durationMs?: number;
    error?: string;
    meta?: Record<string, string | number | boolean | null>;
}

export interface SandboxLogContext {
    reviewRunId?: string;
    validationRunId?: string;
    provider: string;
    runtime?: string;
    cpu?: string;
    memory?: string;
    timeout?: number;
    exitCode?: number;
    checks?: Record<string, string>;
}

const REDACT_PATTERNS = [
    /ghp_[A-Za-z0-9]+/g,     // GitHub PAT
    /gho_[A-Za-z0-9]+/g,     // GitHub OAuth
    /ghu_[A-Za-z0-9]+/g,     // GitHub user token
    /sk-[A-Za-z0-9]+/g,      // OpenAI/API keys
    /AIza[A-Za-z0-9_-]+/g,   // Google API keys
    /e2b_[A-Za-z0-9]+/g,     // E2B API keys
    /postgres:\/\/[^\s]+/g,   // DB URLs
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWTs
];

function redactSecrets(str: string): string {
    let result = str;
    for (const pattern of REDACT_PATTERNS) {
        result = result.replace(pattern, '[REDACTED]');
    }
    return result;
}

export function logPipelineEvent(ctx: PipelineLogContext): void {
    const safe: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: ctx.status === 'FAILED' || ctx.status === 'TIMEOUT' ? 'error' : 'info',
        stage: ctx.stage,
        status: ctx.status,
    };

    if (ctx.reviewRunId) safe.reviewRunId = ctx.reviewRunId;
    if (ctx.repositoryId) safe.repositoryId = ctx.repositoryId;
    if (ctx.prNumber) safe.prNumber = ctx.prNumber;
    if (ctx.headSha) safe.headSha = ctx.headSha;
    if (ctx.durationMs !== undefined) safe.durationMs = ctx.durationMs;
    if (ctx.error) safe.error = redactSecrets(ctx.error).substring(0, 500);
    if (ctx.meta) safe.meta = ctx.meta;

    const line = JSON.stringify(safe);
    if (safe.level === 'error') {
        console.error(`[prism] ${line}`);
    } else {
        console.log(`[prism] ${line}`);
    }
}

export function logSandboxEvent(ctx: SandboxLogContext): void {
    const safe: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: 'info',
        component: 'sandbox',
        provider: ctx.provider,
    };

    if (ctx.reviewRunId) safe.reviewRunId = ctx.reviewRunId;
    if (ctx.validationRunId) safe.validationRunId = ctx.validationRunId;
    if (ctx.runtime) safe.runtime = ctx.runtime;
    if (ctx.cpu) safe.cpu = ctx.cpu;
    if (ctx.memory) safe.memory = ctx.memory;
    if (ctx.timeout) safe.timeout = ctx.timeout;
    if (ctx.exitCode !== undefined) safe.exitCode = ctx.exitCode;
    if (ctx.checks) safe.checks = ctx.checks;

    console.log(`[prism:sandbox] ${JSON.stringify(safe)}`);
}

export interface Metrics {
    webhookReceived: number;
    webhookFailed: number;
    webhookDeduplicated: number;
    runnerJobsDispatched: number;
    runnerJobsFailed: number;
    callbacksReceived: number;
    callbacksFailed: number;
    semgrepScans: number;
    semgrepFailures: number;
    classifierCalls: number;
    classifierFallbacks: number;
    llmCalls: number;
    llmFailures: number;
    sandboxCreated: number;
    sandboxTimeouts: number;
    sandboxAbuse: number;
    validationRuns: number;
    applyAttempts: number;
    applyFailures: number;
    dbErrors: number;
    staleApprovals: number;
    increment(key: keyof Omit<Metrics, 'increment' | 'snapshot'>): void;
    snapshot(): Record<string, number>;
}

/** Metrics counters for production dashboards */
export const metrics: Metrics = {
    webhookReceived: 0,
    webhookFailed: 0,
    webhookDeduplicated: 0,
    runnerJobsDispatched: 0,
    runnerJobsFailed: 0,
    callbacksReceived: 0,
    callbacksFailed: 0,
    semgrepScans: 0,
    semgrepFailures: 0,
    classifierCalls: 0,
    classifierFallbacks: 0,
    llmCalls: 0,
    llmFailures: 0,
    sandboxCreated: 0,
    sandboxTimeouts: 0,
    sandboxAbuse: 0,
    validationRuns: 0,
    applyAttempts: 0,
    applyFailures: 0,
    dbErrors: 0,
    staleApprovals: 0,

    increment(key: keyof Omit<Metrics, 'increment' | 'snapshot'>) {
        if (typeof this[key] === 'number') {
            (this as any)[key] = ((this as any)[key] as number) + 1;
        }
    },

    snapshot(): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [key, val] of Object.entries(this)) {
            if (typeof val === 'number') {
                result[key] = val;
            }
        }
        return result;
    }
};

export type MetricsKeys = keyof Omit<typeof metrics, 'increment' | 'snapshot'>;
