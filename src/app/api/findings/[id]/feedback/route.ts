import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { FEEDBACK_LIMIT, rateLimit } from "@/lib/rate-limit";
import { FEEDBACK_ACTIONS, recordFeedback } from "@/modules/review/lib/feedback";
import { FalseAlarmReason } from "@/generated/prisma/client";

const FeedbackSchema = z.object({ action: z.enum(FEEDBACK_ACTIONS), reason: z.nativeEnum(FalseAlarmReason).optional() }).strict();
const MAX_BODY_BYTES = 256;

const json = (body: unknown, status: number, headers?: Record<string, string>) => NextResponse.json(body, { status, headers });

/** A browser sends Origin on every cross-site POST. Accept only our own. */
function sameOrigin(req: NextRequest): boolean {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
        return new URL(origin).host === (req.headers.get("x-forwarded-host") || req.headers.get("host"));
    } catch {
        return false;
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
    if (!session?.user?.id) return json({ error: "Unauthorized" }, 401);

    if (!sameOrigin(req)) return json({ error: "Forbidden" }, 403);
    if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
        return json({ error: "Expected application/json" }, 415);
    }

    const limited = rateLimit(`feedback:${session.user.id}`, FEEDBACK_LIMIT);
    if (!limited.allowed) {
        return json({ error: "Too many requests. Try again shortly." }, 429, { "Retry-After": String(limited.retryAfterSeconds) });
    }

    const raw = await req.text().catch(() => "");
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413);
    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        return json({ error: "Invalid action" }, 400);
    }
    const parsed = FeedbackSchema.safeParse(body);
    if (!parsed.success) return json({ error: "Invalid action" }, 400);

    // Ownership is part of the lookup (repository: { userId: session.user.id }), so a finding in
    // someone else's repository is indistinguishable from one that does not exist.
    const { id } = await params;
    const result = await recordFeedback(session.user.id, id, parsed.data.action, parsed.data.reason);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ verdict: result.verdict, unsuppressed: result.unsuppressed }, 200);
}
