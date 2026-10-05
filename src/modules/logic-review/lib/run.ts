import { generateObject } from "ai";
import { getReviewModel, getReviewModelName } from "@/lib/ai";
import { parseDiffFiles, selectFilesForReview } from "./diff-files";
import { buildLogicReviewPrompt, LOGIC_REVIEW_SYSTEM_PROMPT } from "./prompt";
import { AcceptedLogicIssue, LogicReviewOutput, LogicReviewOutputSchema, ToolFindingRef } from "./schema";
import { DiscardReason, validateLogicIssues } from "./validate";

const MAX_PROMPT_DIFF_CHARS = parseInt(process.env.LOGIC_REVIEW_MAX_DIFF_CHARS || "60000", 10);

export interface LogicReviewInput {
    diff: string;
    title: string;
    description: string;
    toolFindings: ToolFindingRef[];
}

export interface LogicReviewCoverage {
    reviewedFiles: string[];
    /** Changed code files that did not fit in the prompt and were not reviewed */
    overBudgetFiles: string[];
    /** Changed files that are not source code */
    notReviewableFiles: number;
}

export type LogicReviewResult =
    | {
        ok: true;
        model: string;
        issues: AcceptedLogicIssue[];
        coverage: LogicReviewCoverage;
        /** How many of the model's issues were rejected, by reason */
        discarded: Partial<Record<DiscardReason, number>>;
    }
    | {
        ok: false;
        model: string;
        code: "LOGIC_REVIEW_MODEL_FAILED" | "LOGIC_REVIEW_INVALID_OUTPUT";
        error: string;
        coverage: LogicReviewCoverage;
    };

/** The model call, replaceable in tests. */
export type LogicReviewGenerate = (args: { system: string; prompt: string }) => Promise<LogicReviewOutput>;

const callModel: LogicReviewGenerate = async ({ system, prompt }) => {
    const { object } = await generateObject({
        model: getReviewModel(),
        schema: LogicReviewOutputSchema,
        system,
        prompt,
        temperature: 0,
        maxRetries: 2,
    });
    return object;
};

/**
 * Review a pull request diff for logic bugs.
 *
 * Never throws. A model failure is returned as { ok: false } so the caller can record that the
 * review did not happen; it is never reported as "no issues". With nothing reviewable in the diff
 * the model is not called at all and the result is an empty, successful review.
 */
export async function runLogicReview(input: LogicReviewInput, generate: LogicReviewGenerate = callModel): Promise<LogicReviewResult> {
    let model = "unknown";
    try { model = getReviewModelName(); } catch { /* reported with the failure below if the call cannot be made */ }

    const selection = selectFilesForReview(parseDiffFiles(input.diff), MAX_PROMPT_DIFF_CHARS);
    const coverage: LogicReviewCoverage = {
        reviewedFiles: selection.reviewed.map(f => f.path),
        overBudgetFiles: selection.overBudget,
        notReviewableFiles: selection.notReviewable.length,
    };

    if (selection.reviewed.length === 0) {
        return { ok: true, model, issues: [], coverage, discarded: {} };
    }

    let output: LogicReviewOutput;
    try {
        output = await generate({
            system: LOGIC_REVIEW_SYSTEM_PROMPT,
            prompt: buildLogicReviewPrompt({
                title: input.title,
                description: input.description,
                renderedDiff: selection.rendered,
                toolFindings: input.toolFindings,
            }),
        });
    } catch (e: any) {
        return { ok: false, model, code: "LOGIC_REVIEW_MODEL_FAILED", error: String(e?.message || e || "The model call failed").slice(0, 500), coverage };
    }

    const parsed = LogicReviewOutputSchema.safeParse(output);
    if (!parsed.success) {
        return { ok: false, model, code: "LOGIC_REVIEW_INVALID_OUTPUT", error: "The model returned output in an unexpected shape", coverage };
    }

    const { accepted, discarded } = validateLogicIssues(parsed.data.issues, selection.reviewed, input.toolFindings);
    return { ok: true, model, issues: accepted, coverage, discarded };
}
