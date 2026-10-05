import { z } from 'zod';

export const SemgrepFindingSchema = z.object({
    check_id: z.string(),
    path: z.string(),
    start: z.object({
        line: z.number(),
        col: z.number().optional(),
        offset: z.number().optional()
    }),
    end: z.object({
        line: z.number(),
        col: z.number().optional(),
        offset: z.number().optional()
    }),
    extra: z.object({
        message: z.string().max(20000), // Size cap
        severity: z.string(),
        metadata: z.any().optional(),
        lines: z.string().max(20000).optional(),
        prism_features: z.object({
            fileSizeLines: z.number(),
            functionLength: z.number().nullable(),
            cyclomaticComplexity: z.number().nullable()
        }).optional()
    })
});

export const SemgrepResultSchema = z.object({
    results: z.array(SemgrepFindingSchema),
    errors: z.array(z.any()).optional(),
    paths: z.object({
        scanned: z.array(z.string()).optional(),
        skipped: z.array(z.any()).optional()
    }).optional(),
    version: z.string().optional()
});

export type SemgrepFinding = z.infer<typeof SemgrepFindingSchema>;
export type SemgrepResult = z.infer<typeof SemgrepResultSchema>;
