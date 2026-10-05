import { z } from "zod";

/** One ESLint message, as the runner returns it after tying it to the scanned tree. */
export const EslintMessageSchema = z.object({
    ruleId: z.string().min(1).max(200).nullable(),
    /** 1 = warning, 2 = error */
    severity: z.union([z.literal(1), z.literal(2)]),
    message: z.string().max(5000),
    line: z.number().int().min(1),
    column: z.number().int().min(0).nullable(),
    endLine: z.number().int().min(1),
    endColumn: z.number().int().min(0).nullable(),
    /** True for a file ESLint could not parse */
    fatal: z.boolean(),
    fix: z.object({ range: z.tuple([z.number().int().min(0), z.number().int().min(0)]), text: z.string() }).nullable(),
    suggestionCount: z.number().int().min(0),
    /** Real source text of line..endLine, read by the runner */
    lines: z.string(),
});

export const EslintFileSchema = z.object({
    filePath: z.string().min(1),
    fileSizeLines: z.number().int().min(1),
    messages: z.array(EslintMessageSchema),
});

export const EslintResultSchema = z.object({
    tool: z.literal("eslint"),
    /** Null when there was nothing to lint, so ESLint never started */
    version: z.string().nullable(),
    results: z.array(EslintFileSchema),
    scanned: z.array(z.string()),
});

export type EslintMessage = z.infer<typeof EslintMessageSchema>;
export type EslintFile = z.infer<typeof EslintFileSchema>;
export type EslintResult = z.infer<typeof EslintResultSchema>;

/** What PRism keeps about an ESLint finding beyond the common fields. Stored in Finding.metadata.eslint. */
export interface EslintFindingMetadata {
    /** 1 = warning, 2 = error */
    severity: 1 | 2;
    ruleFamily: string;
    hasFix: boolean;
    fixTextLength: number;
    fixRangeLength: number;
    suggestionCount: number;
    fileSizeLines: number;
}
