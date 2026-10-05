/**
 * Sliding-window rate limit, kept in this process's memory. It slows down a script hammering
 * an endpoint; it is not a guarantee across several server instances. Anything that must hold
 * regardless (one answer per issue, one decision per fix) is enforced in the database instead.
 */

interface Limit {
    limit: number;
    windowMs: number;
}

const MAX_KEYS = 10000;
const hits = new Map<string, number[]>();

export interface RateLimitResult {
    allowed: boolean;
    /** Seconds until the next request would be allowed; 0 when allowed */
    retryAfterSeconds: number;
}

export function rateLimit(key: string, { limit, windowMs }: Limit, now = Date.now()): RateLimitResult {
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= limit) {
        hits.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
    }
    recent.push(now);
    // Re-insert so the map stays ordered by last use, then drop the least recently used keys.
    hits.delete(key);
    hits.set(key, recent);
    while (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value as string);
    return { allowed: true, retryAfterSeconds: 0 };
}

/** For tests */
export function resetRateLimits() {
    hits.clear();
}

export const FEEDBACK_LIMIT: Limit = { limit: 40, windowMs: 60_000 };
export const FIX_DECISION_LIMIT: Limit = { limit: 20, windowMs: 60_000 };
