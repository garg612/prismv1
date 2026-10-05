import { z } from "zod";

/**
 * Logic review findings are stored as findings with this source. It is deliberately not a
 * registered scanner: nothing re-scans for these, nothing triages them and nothing fixes them
 * automatically.
 */
export const LOGIC_REVIEW_SOURCE = "CUSTOM" as const;

/** Bump when the prompt or the acceptance rules change, so results can be told apart. */
export const LOGIC_REVIEW_VERSION = "logic-review-v1";

export const LOGIC_CATEGORIES = [
    "wrong-condition",
    "off-by-one",
    "null-or-undefined",
    "wrong-variable-or-argument",
    "missing-await-or-async",
    "error-handling",
    "state-or-ordering",
    "empty-or-boundary-input",
    "wrong-calculation",
    "concurrency-or-resource",
    "contract-mismatch",
    "other-logic",
] as const;

export const LogicIssueSchema = z.object({
    filePath: z.string().describe("Path exactly as shown in the '### <path>' heading"),
    startLine: z.number().int().describe("Line number of the first affected line, from the left column"),
    endLine: z.number().int().describe("Line number of the last affected line (same as startLine for one line)"),
    quotedLine: z.string().describe("The exact text of the line at startLine, copied from the diff"),
    title: z.string().describe("One short sentence naming the bug"),
    explanation: z.string().describe("What goes wrong, with a concrete input or sequence that triggers it"),
    suggestion: z.string().describe("How to correct it, in words. No patch."),
    category: z.enum(LOGIC_CATEGORIES),
    severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
});

export const LogicReviewOutputSchema = z.object({
    issues: z.array(LogicIssueSchema),
});

export type LogicIssue = z.infer<typeof LogicIssueSchema>;
export type LogicReviewOutput = z.infer<typeof LogicReviewOutputSchema>;

/** What a scanner already reported, as far as the logic review needs to know. */
export interface ToolFindingRef {
    filePath: string;
    startLine: number;
    endLine: number;
    ruleId: string;
    message: string;
}

/** An issue that passed every acceptance rule and is tied to real lines of the diff. */
export interface AcceptedLogicIssue {
    filePath: string;
    startLine: number;
    endLine: number;
    /** Read from the diff, never from the model */
    codeSnippet: string;
    title: string;
    explanation: string;
    suggestion: string;
    category: (typeof LOGIC_CATEGORIES)[number];
    severity: "HIGH" | "MEDIUM" | "LOW";
    confidence: "HIGH" | "MEDIUM";
}
