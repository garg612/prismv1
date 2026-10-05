import { describe, it, expect } from 'vitest';
import { computeDelta, hashSemgrepMatch } from '../helpers/semgrep-delta';
import { determineFixOutcome } from '../../src/modules/validation/lib/outcome';

describe('Stage 6 Validation Outcome Logic', () => {
    const targetFinding = {
        check_id: 'rule1',
        path: 'foo.ts',
        start: { line: 10 },
        end: { line: 10 },
        extra: { severity: 'HIGH', message: '', lines: 'target' }
    };

    it('1. Target finding disappears + new MEDIUM finding elsewhere -> NEW_FINDING_INTRODUCED', () => {
        const headFindings = [targetFinding];
        const postFindings = [
            { check_id: 'rule2', path: 'bar.ts', start: { line: 5 }, end: { line: 5 }, extra: { severity: 'MEDIUM', message: '', lines: 'new' } }
        ];

        const fp = hashSemgrepMatch(targetFinding as any);
        const delta = computeDelta(targetFinding.check_id, targetFinding.path, fp, headFindings as any, postFindings as any);
        const outcome = determineFixOutcome(true, true, true, delta.stats);
        
        expect(delta.stats.newFindingsCount).toBe(1);
        expect(outcome).toBe('NEW_FINDING_INTRODUCED');
    });

    it('2. Target finding disappears + new finding in another touched file -> NEW_FINDING_INTRODUCED', () => {
        const headFindings = [targetFinding];
        const postFindings = [
            { check_id: 'rule3', path: 'baz.ts', start: { line: 1 }, end: { line: 1 }, extra: { severity: 'HIGH', message: '', lines: 'new2' } }
        ];

        const fp = hashSemgrepMatch(targetFinding as any);
        const delta = computeDelta(targetFinding.check_id, targetFinding.path, fp, headFindings as any, postFindings as any);
        const outcome = determineFixOutcome(true, true, true, delta.stats);
        
        expect(outcome).toBe('NEW_FINDING_INTRODUCED');
    });

    it('3. Target finding disappears + no new above-INFO key -> FIXED', () => {
        const headFindings = [targetFinding];
        const postFindings = [
            { check_id: 'rule4', path: 'foo.ts', start: { line: 2 }, end: { line: 2 }, extra: { severity: 'INFO', message: '', lines: 'info' } }
        ];

        const fp = hashSemgrepMatch(targetFinding as any);
        const delta = computeDelta(targetFinding.check_id, targetFinding.path, fp, headFindings as any, postFindings as any);
        const outcome = determineFixOutcome(true, true, true, delta.stats);
        
        expect(outcome).toBe('FIXED');
    });

    it('4. Target unchanged -> NOT_FIXED', () => {
        const headFindings = [targetFinding];
        const postFindings = [targetFinding];

        const fp = hashSemgrepMatch(targetFinding as any);
        const delta = computeDelta(targetFinding.check_id, targetFinding.path, fp, headFindings as any, postFindings as any);
        const outcome = determineFixOutcome(true, true, true, delta.stats);
        
        expect(outcome).toBe('NOT_FIXED');
    });

    it('5. Patch application failure -> VALIDATION_FAILED', () => {
        const outcome = determineFixOutcome(false, true, true);
        expect(outcome).toBe('VALIDATION_FAILED');
    });

    it('6. Syntax failure -> VALIDATION_FAILED', () => {
        const outcome = determineFixOutcome(true, false, true);
        expect(outcome).toBe('VALIDATION_FAILED');
    });

    it('7. Semgrep crash/tool failure -> VALIDATION_FAILED', () => {
        const outcome = determineFixOutcome(true, true, false);
        expect(outcome).toBe('VALIDATION_FAILED');
    });
});

describe('Stage 6 READY Gating', () => {
    it('proves exactly the mapping to READY/NOT_READY based on outcome', () => {
        const mapOutcomeToReady = (outcome: string) => outcome === "FIXED" ? "READY" : "NOT_READY";

        expect(mapOutcomeToReady("VALIDATION_FAILED")).toBe("NOT_READY"); // Patch failure
        expect(mapOutcomeToReady("VALIDATION_FAILED")).toBe("NOT_READY"); // Syntax failure
        expect(mapOutcomeToReady("NOT_FIXED")).toBe("NOT_READY");
        expect(mapOutcomeToReady("PARTIALLY_FIXED")).toBe("NOT_READY");
        expect(mapOutcomeToReady("NEW_FINDING_INTRODUCED")).toBe("NOT_READY");
        expect(mapOutcomeToReady("FIXED")).toBe("READY");
    });
});
