import { generateObject } from 'ai';
import { getFixModel } from '@/lib/ai';
import { readRateLimit, describeRateLimit, RateLimit } from '@/lib/ai-rate-limit';
import { FixProposalSchema, FixProposal } from './schema';
import { buildFixPrompt } from './prompt';
import { runGuards, GuardContext } from './guards';
import { generateDeterministicPatch, PatchStats } from './diff';
import { SourceWindow } from './source-window';

export interface GenerationResult {
    /**
     * GENERATED         — a real model proposal passed the guards and produced a patch
     * GUARD_REJECTED    — a real model proposal was rejected deterministically (repairable)
     * GENERATION_FAILED — the model produced nothing usable; no proposal exists
     * RATE_LIMITED      — the model provider refused the request for now; the caller may wait and ask again
     */
    status: 'GENERATED' | 'GUARD_REJECTED' | 'GENERATION_FAILED' | 'RATE_LIMITED';
    rateLimit?: RateLimit;
    proposal?: FixProposal;
    patch?: PatchStats;
    failureReason?: string;
    modelExplanation?: string;
    modelUsage?: any;
    selfConfidence?: number;
}

export interface FixableFinding {
    id: string;
    message: string;
    ruleId: string;
    filePath: string;
    startLine: number;
    endLine: number;
    codeSnippet?: string | null;
}

export async function generateFix(
    finding: FixableFinding,
    source: SourceWindow,
    ragContext: string[],
    baseFileContents: Record<string, string>,
    lastError?: string
): Promise<GenerationResult> {
    const prompt = buildFixPrompt(finding, source, ragContext, lastError);

    let proposal: FixProposal;
    let usage: unknown;
    try {
        const result = await generateObject({
            model: getFixModel(),
            schema: FixProposalSchema,
            prompt,
            // Transient provider errors (429/503) are retried with backoff; anything
            // still failing after that is reported as GENERATION_FAILED.
            maxRetries: 2
        });
        proposal = result.object;
        usage = result.usage;
    } catch (e: any) {
        const rateLimit = readRateLimit(e);
        if (rateLimit) {
            console.warn("Fix model rate limited for finding", finding.id, rateLimit);
            return { status: 'RATE_LIMITED', rateLimit, failureReason: describeRateLimit(rateLimit) };
        }
        // No fallback: if the model did not produce a proposal, there is no fix.
        console.error("LLM fix generation failed for finding", finding.id, e);
        return { status: 'GENERATION_FAILED', failureReason: `LLM generation failed: ${e?.message || 'unknown error'}` };
    }

    // Run deterministic guards
    const guardContext: GuardContext = {
        baseFileContents,
        findingPath: finding.filePath,
        findingStartLine: finding.startLine,
        findingEndLine: finding.endLine
    };

    const guardResult = runGuards(proposal, guardContext);
    if (!guardResult.passed) {
        return { status: 'GUARD_REJECTED', failureReason: guardResult.reason };
    }

    // Produce diff
    let patchStats: PatchStats;
    try {
        patchStats = generateDeterministicPatch(proposal, baseFileContents);
    } catch (patchErr: any) {
        return { status: 'GUARD_REJECTED', failureReason: `Patch generation failed: ${patchErr.message}` };
    }

    return {
        status: 'GENERATED',
        proposal,
        patch: patchStats,
        modelExplanation: proposal.explanation,
        selfConfidence: proposal.selfConfidence,
        modelUsage: usage
    };
}
