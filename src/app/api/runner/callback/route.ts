import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyHmac } from '@/modules/runner/lib/client';
import { inngest } from '@/inngest/client';
import prisma from '@/lib/db';

const CallbackPayloadSchema = z.object({
    scanRunId: z.string().optional(),
    validationRunId: z.string().optional(),
    status: z.enum(['COMPLETED', 'FAILED']),
    error: z.string().optional(),
    errorCode: z.string().max(100).optional(),
    timestamp: z.number(),
    // Which scanner produced the result, and its output. The scanner's adapter validates the shape.
    tool: z.string().max(40).optional(),
    toolResult: z.unknown().optional(),
    repoLOC: z.number().optional(),
    checkResults: z.any().optional(),
    execResults: z.any().optional()
});

export async function POST(req: Request) {
    const signature = req.headers.get('x-runner-callback-signature') || req.headers.get('X-Runner-Callback-Signature');
    if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });

    const RUNNER_CALLBACK_SECRET = process.env.RUNNER_CALLBACK_SECRET;
    if (!RUNNER_CALLBACK_SECRET) return NextResponse.json({ error: "Configuration error" }, { status: 500 });

    let bodyStr: string;
    try {
        bodyStr = await req.text();
    } catch {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    if (!verifyHmac(bodyStr, signature, RUNNER_CALLBACK_SECRET)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let parsedBody;
    try {
        parsedBody = JSON.parse(bodyStr);
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const validation = CallbackPayloadSchema.safeParse(parsedBody);
    if (!validation.success) {
        return NextResponse.json({ error: "Schema validation failed", details: validation.error }, { status: 400 });
    }

    const { scanRunId, validationRunId, status, error, errorCode, timestamp, tool, toolResult, repoLOC, checkResults, execResults } = validation.data;

    if (Date.now() - timestamp > 5 * 60 * 1000) {
        return NextResponse.json({ error: "Request expired" }, { status: 401 });
    }

    if (scanRunId) {
        const scanRun = await prisma.scanRun.findUnique({ where: { id: scanRunId } });
        if (!scanRun) {
            return NextResponse.json({ error: "Unknown job ID" }, { status: 404 });
        }
        if (scanRun.status === 'COMPLETED' || scanRun.status === 'FAILED' || scanRun.status === 'TIMEOUT') {
            return NextResponse.json({ status: "Duplicate callback ignored" }, { status: 200 });
        }

        await inngest.send({
            name: 'runner.scan.completed',
            data: {
                scanRunId,
                status,
                error,
                errorCode,
                tool,
                toolResult,
                repoLOC
            }
        });
    } else if (validationRunId) {
        const valRun = await prisma.validationRun.findUnique({ where: { id: validationRunId } });
        if (!valRun) {
            return NextResponse.json({ error: "Unknown job ID" }, { status: 404 });
        }
        if (valRun.status === 'COMPLETED' || valRun.status === 'FAILED' || valRun.status === 'TIMEOUT') {
            return NextResponse.json({ status: "Duplicate callback ignored" }, { status: 200 });
        }

        await inngest.send({
            name: 'runner.validate.completed',
            data: {
                validationRunId,
                status,
                error,
                errorCode,
                tool,
                toolResult,
                checkResults,
                execResults
            }
        });
    } else {
        return NextResponse.json({ error: "No run ID provided" }, { status: 400 });
    }

    return NextResponse.json({ status: "Accepted" }, { status: 202 });
}
