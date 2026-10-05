import { z } from 'zod';

export const EditSchema = z.object({
    path: z.string().min(1).max(500).describe("The exact relative path to the file from the repository root"),
    find: z.string().describe("The exact literal string to be replaced. MUST exactly match existing file content including whitespace. Not a regex."),
    replace: z.string().describe("The new literal string to replace the find block with. Be careful to preserve indentation.")
});

export const FixProposalSchema = z.object({
    findingId: z.string().min(1).max(100),
    explanation: z.string().max(2000),
    edits: z.array(EditSchema).max(50),
    riskNotes: z.string().max(2000),
    selfConfidence: z.number().min(0).max(1)
}).strict();

export type Edit = z.infer<typeof EditSchema>;
export type FixProposal = z.infer<typeof FixProposalSchema>;
