-- AlterEnum
ALTER TYPE "DecisionSource" ADD VALUE 'POLICY';

-- AlterEnum
ALTER TYPE "TriageDecision" ADD VALUE 'UNCERTAIN';

-- AlterTable
ALTER TABLE "finding" ADD COLUMN     "triageDecision" "TriageDecision";
