import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_SINGLE_WAIT_MS, MAX_TOTAL_WAIT_MS, describeRateLimit, parseDuration, planRateLimitWait, readRateLimit } from "../../src/lib/ai-rate-limit";

// The provider's real answer when the daily quota ran out during end-to-end testing.
const DAILY = "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_abc123` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199508, Requested 1649. Please try again in 8m19.824s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing";
const MINUTE = "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_abc123` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7200, Requested 1649. Please try again in 6.37s.";

const apiError = (message: string, headers?: Record<string, string>) => ({ name: "AI_APICallError", statusCode: 429, message, responseHeaders: headers });
/** What the SDK throws once its own retries are used up */
const retryError = (inner: unknown) => ({ name: "AI_RetryError", message: "Failed after 3 attempts.", lastError: inner });

describe("reading a duration", () => {
    it("reads the forms the provider uses", () => {
        expect(parseDuration("6.37s")).toBe(6370);
        expect(parseDuration("8m19.824s")).toBe(499824);
        expect(parseDuration("350ms")).toBe(350);
        expect(parseDuration("1h2m3s")).toBe(3723000);
        expect(parseDuration("2m")).toBe(120000);
    });

    it("returns null for anything else", () => {
        for (const text of ["", "soon", "12", "s", "1x"]) expect(parseDuration(text)).toBeNull();
    });
});

describe("recognising a rate limit", () => {
    it("reads a per-minute limit and its wait from the message", () => {
        expect(readRateLimit(apiError(MINUTE))).toEqual({ retryAfterMs: 6370, scope: "minute" });
    });

    it("reads a per-day limit", () => {
        expect(readRateLimit(apiError(DAILY))).toEqual({ retryAfterMs: 499824, scope: "day" });
    });

    it("looks inside the error the SDK wraps it in after retrying", () => {
        expect(readRateLimit(retryError(apiError(MINUTE)))?.scope).toBe("minute");
    });

    it("prefers the retry-after header", () => {
        expect(readRateLimit(apiError(MINUTE, { "retry-after": "9" }))?.retryAfterMs).toBe(9000);
    });

    it("recognises a 429 that says nothing about how long", () => {
        expect(readRateLimit({ statusCode: 429, message: "Too Many Requests" })).toEqual({ retryAfterMs: null, scope: "unknown" });
    });

    it("is null for every other failure", () => {
        expect(readRateLimit({ statusCode: 503, message: "Service unavailable" })).toBeNull();
        expect(readRateLimit(new Error("No object generated: response did not match schema"))).toBeNull();
        expect(readRateLimit(undefined)).toBeNull();
        expect(readRateLimit(null)).toBeNull();
    });
});

describe("deciding whether to wait", () => {
    it("waits as long as a per-minute limit asks, plus the spread", () => {
        expect(planRateLimitWait({ retryAfterMs: 6370, scope: "minute" }, 0)).toBe(6370);
        expect(planRateLimitWait({ retryAfterMs: 6370, scope: "minute" }, 0, 2500)).toBe(8870);
    });

    it("never waits for a daily limit, however short the provider says", () => {
        expect(planRateLimitWait({ retryAfterMs: 1000, scope: "day" }, 0)).toBeNull();
        expect(planRateLimitWait({ retryAfterMs: 499824, scope: "day" }, 0)).toBeNull();
    });

    it("does not hold a review open for one long wait", () => {
        expect(planRateLimitWait({ retryAfterMs: MAX_SINGLE_WAIT_MS, scope: "minute" }, 0)).toBe(MAX_SINGLE_WAIT_MS);
        expect(planRateLimitWait({ retryAfterMs: MAX_SINGLE_WAIT_MS + 1, scope: "minute" }, 0)).toBeNull();
    });

    it("stops once the waits for one fix add up to the total allowed", () => {
        const limit = { retryAfterMs: 60_000, scope: "minute" as const };
        let waited = 0, waits = 0;
        for (;;) {
            const next = planRateLimitWait(limit, waited);
            if (next === null) break;
            waited += next; waits++;
            expect(waits).toBeLessThan(100);
        }
        expect(waited).toBeLessThanOrEqual(MAX_TOTAL_WAIT_MS);
        expect(waits).toBe(8);
    });

    it("uses a default wait when the provider gave none, and still stops", () => {
        const limit = { retryAfterMs: null, scope: "unknown" as const };
        expect(planRateLimitWait(limit, 0)).toBe(20_000);
        expect(planRateLimitWait(limit, MAX_TOTAL_WAIT_MS)).toBeNull();
    });
});

describe("what is stored for the person", () => {
    it("says which limit it was and when it clears, without the provider's raw text", () => {
        const daily = describeRateLimit(readRateLimit(apiError(DAILY))!);
        expect(daily).toBe("Rate limit: the AI model's daily usage limit is used up. It accepts requests again in about 9 minutes.");
        expect(daily).not.toMatch(/org_|groq|console/i);
        expect(describeRateLimit({ retryAfterMs: 30_000, scope: "minute" })).toBe("Rate limit: the AI model was still refusing requests after waiting. It accepts requests again in about 1 minute.");
        expect(describeRateLimit({ retryAfterMs: null, scope: "unknown" })).toBe("Rate limit: the AI model was still refusing requests after waiting.");
    });
});

const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock("ai", () => ({ generateObject }));
vi.mock("../../src/lib/ai", () => ({ getFixModel: () => "model" }));

describe("fix generation when the model refuses", () => {
    const finding = { id: "f1", message: "Unexpected 'debugger' statement.", ruleId: "no-debugger", filePath: "lib/a.js", startLine: 2, endLine: 2, codeSnippet: "debugger;" };
    const source = { text: "function a() {\n  debugger;\n}\n", startLine: 1, endLine: 3, truncated: false } as any;

    beforeEach(() => { generateObject.mockReset(); });

    it("reports a rate limit as its own outcome, not as a failed generation", async () => {
        const { generateFix } = await import("../../src/modules/fix/lib/generate");
        generateObject.mockImplementation(async () => { throw retryError(apiError(MINUTE)); });
        const result = await generateFix(finding, source, [], { "lib/a.js": source.text });
        expect(result.status).toBe("RATE_LIMITED");
        expect(result.rateLimit).toEqual({ retryAfterMs: 6370, scope: "minute" });
        expect(result.failureReason).not.toMatch(/org_/);
    });

    it("still reports any other model error as a failed generation", async () => {
        const { generateFix } = await import("../../src/modules/fix/lib/generate");
        generateObject.mockImplementation(async () => { throw new Error("No object generated"); });
        const result = await generateFix(finding, source, [], { "lib/a.js": source.text });
        expect(result.status).toBe("GENERATION_FAILED");
        expect(result.failureReason).toContain("No object generated");
    });
});

describe("how the fix worker uses it", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/inngest/functions/process-finding.ts"), "utf8");

    it("waits and asks again without using up an attempt", () => {
        expect(src).toContain("planRateLimitWait(result.rateLimit!, waitedMs");
        expect(src).toMatch(/await step\.sleep\("rate-limit-wait-"/);
        // the retry continues the same fix row instead of leaving a failed one behind
        expect(src).toContain("pendingFixId ? { id: pendingFixId }");
    });

    it("does not try a second attempt straight away when the limit will not clear", () => {
        expect(src).toContain('if (fixGenResult.rateLimitExhausted) return { success: true, outcome: "RATE_LIMITED" };');
    });
});
