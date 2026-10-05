/**
 * Reading a "too many requests" answer from the AI model provider, and deciding whether to wait.
 *
 * Providers limit use per minute and per day. A per-minute limit clears in seconds, so the caller
 * waits and tries again. A per-day limit does not, so the caller stops and says so.
 */

export interface RateLimit {
    /** How long the provider asked us to wait; null when it did not say */
    retryAfterMs: number | null;
    scope: "minute" | "day" | "unknown";
}

const DEFAULT_WAIT_MS = 20_000;
/** A single wait longer than this is not worth holding a review open for */
export const MAX_SINGLE_WAIT_MS = 2 * 60_000;
/** All waits for one fix together */
export const MAX_TOTAL_WAIT_MS = 8 * 60_000;

/** "8m19.824s", "1.5s", "350ms", "1h2m" -> milliseconds */
export function parseDuration(text: string): number | null {
    const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(text.trim());
    if (!match || match.slice(1).every(part => part === undefined)) return null;
    const [h, m, s, ms] = match.slice(1).map(part => (part === undefined ? 0 : parseFloat(part)));
    return Math.ceil(h * 3_600_000 + m * 60_000 + s * 1000 + ms);
}

/** The rate limit an error from the AI SDK describes, or null when it is some other error. */
export function readRateLimit(error: unknown): RateLimit | null {
    // The SDK wraps the provider's answer in a RetryError once its own retries are used up.
    const e: any = (error as any)?.lastError ?? error;
    if (!e) return null;
    const message = String(e.message ?? "");
    if (e.statusCode !== 429 && !/rate limit|too many requests/i.test(message)) return null;

    let retryAfterMs: number | null = null;
    const header = e.responseHeaders?.["retry-after"];
    if (header !== undefined && Number.isFinite(Number(header))) retryAfterMs = Math.ceil(Number(header) * 1000);
    if (retryAfterMs === null) {
        const inText = /try again in ([0-9hms.]+?)\.?(?:\s|$)/i.exec(message);
        if (inText) retryAfterMs = parseDuration(inText[1]);
    }

    const scope = /per day|\((TPD|RPD)\)/i.test(message) ? "day"
        : /per minute|\((TPM|RPM)\)/i.test(message) ? "minute"
        : "unknown";
    return { retryAfterMs, scope };
}

/**
 * How long to wait before asking again, or null when waiting is not reasonable.
 * `jitterMs` spreads out fixes that were refused at the same moment.
 */
export function planRateLimitWait(limit: RateLimit, alreadyWaitedMs: number, jitterMs = 0): number | null {
    if (limit.scope === "day") return null;
    const wait = limit.retryAfterMs ?? DEFAULT_WAIT_MS;
    if (wait > MAX_SINGLE_WAIT_MS) return null;
    if (alreadyWaitedMs + wait > MAX_TOTAL_WAIT_MS) return null;
    return wait + Math.max(0, jitterMs);
}

/** One sentence for the person reading the review. It never includes the provider's raw text. */
export function describeRateLimit(limit: RateLimit): string {
    const minutes = limit.retryAfterMs === null ? null : Math.max(1, Math.ceil(limit.retryAfterMs / 60_000));
    const when = minutes === null ? "" : ` It accepts requests again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    if (limit.scope === "day") return `Rate limit: the AI model's daily usage limit is used up.${when}`;
    return `Rate limit: the AI model was still refusing requests after waiting.${when}`;
}
