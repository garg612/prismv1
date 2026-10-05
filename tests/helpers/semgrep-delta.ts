/**
 * Test helper: drive the scanner-neutral computeDelta with Semgrep-shaped findings,
 * the way the Semgrep adapter feeds it in the pipeline.
 */
import { computeDelta as computeNeutralDelta, DeltaFinding } from '../../src/modules/validation/lib/delta';
import { generateFingerprint } from '../../src/modules/scanners/semgrep/fingerprint';
import { toRepoRelativePath } from '../../src/modules/scanners/semgrep/path';
import { normalizeSemgrepSeverity } from '../../src/modules/scanners/semgrep/normalize';
import type { SemgrepFinding } from '../../src/modules/scanners/semgrep/schema';

export function hashSemgrepMatch(finding: SemgrepFinding): string {
    return generateFingerprint(finding.check_id, toRepoRelativePath(finding.path), finding.extra?.lines || '');
}

function toDeltaFinding(finding: SemgrepFinding): DeltaFinding {
    return {
        ruleId: finding.check_id,
        filePath: finding.path,
        fingerprint: hashSemgrepMatch(finding),
        severity: normalizeSemgrepSeverity(finding.extra.severity),
        startLine: finding.start.line
    };
}

export function computeDelta(
    targetRuleId: string,
    targetPath: string,
    targetFingerprint: string,
    headFindings: SemgrepFinding[],
    postFixFindings: SemgrepFinding[]
) {
    return computeNeutralDelta(
        { ruleId: targetRuleId, filePath: targetPath, fingerprint: targetFingerprint },
        headFindings.map(toDeltaFinding),
        postFixFindings.map(toDeltaFinding)
    );
}
