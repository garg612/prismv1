import { FixOutcome } from '@/generated/prisma/client';
import { DeltaStats } from './delta';

export function determineFixOutcome(
    patchApplySuccess: boolean,
    syntaxSuccess: boolean,
    rescanSuccess: boolean,
    deltaStats?: DeltaStats
): FixOutcome {
    if (!patchApplySuccess || !syntaxSuccess || !rescanSuccess) {
        return "VALIDATION_FAILED";
    }

    if (!deltaStats) {
        return "UNVERIFIED";
    }

    if (deltaStats.newFindingsCount > 0) {
        return "NEW_FINDING_INTRODUCED";
    }

    if (deltaStats.targetFindingStatus === 'UNCHANGED') {
        return "NOT_FIXED";
    }

    if (deltaStats.partiallyFixed) {
        return "PARTIALLY_FIXED";
    }

    return "FIXED";
}
