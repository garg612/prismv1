import { describe, it, expect, vi, beforeEach } from 'vitest';
// We simulate the logic block from review-run.ts here since it's embedded in the orchestrator

describe('Feedback Rules Live Triage', () => {
    let mockFindings: any[];
    let mockRules: any[];

    beforeEach(() => {
        mockFindings = [];
        mockRules = [];
        process.env.FEEDBACK_RULES = 'local';
    });

    function evaluateFinding(f: any) {
        const matchedRule = mockRules.find(rule => 
            rule.ruleId === f.ruleId &&
            (!rule.fingerprint || rule.fingerprint === f.fingerprint)
        );

        let finalDecision = 'SURFACE';
        let decisionSource = 'POLICY';

        if (matchedRule && (process.env.FEEDBACK_RULES === 'shadow' || process.env.FEEDBACK_RULES === 'local' || process.env.FEEDBACK_RULES === 'global')) {
            const isShadowMode = process.env.FEEDBACK_RULES === 'shadow';

            if (!isShadowMode) {
                const isHighOrCritical = f.severity === 'HIGH' || f.severity === 'CRITICAL';
                
                // Safety Floor
                if (!isHighOrCritical || matchedRule.action === 'SURFACE') {
                    finalDecision = matchedRule.action;
                    decisionSource = 'OVERRIDE';
                }
            }
        }

        return { finalDecision, decisionSource };
    }

    it('Tenant Isolation: applies only rules matching the findings ruleId', () => {
        mockRules.push({ id: 'rule1', ruleId: 'no-console', action: 'SUPPRESS' });
        
        // Match
        const match = evaluateFinding({ ruleId: 'no-console', severity: 'MEDIUM' });
        expect(match.finalDecision).toBe('SUPPRESS');
        expect(match.decisionSource).toBe('OVERRIDE');

        // Mismatch (Different repo would not have fetched this rule, but simulating mismatched ruleId here)
        const mismatch = evaluateFinding({ ruleId: 'no-debugger', severity: 'MEDIUM' });
        expect(mismatch.finalDecision).toBe('SURFACE');
        expect(mismatch.decisionSource).toBe('POLICY');
    });

    it('Security Floor: ignores SUPPRESS rules on HIGH and CRITICAL findings', () => {
        mockRules.push({ id: 'rule2', ruleId: 'sql-injection', action: 'SUPPRESS' });

        const resultHigh = evaluateFinding({ ruleId: 'sql-injection', severity: 'HIGH' });
        expect(resultHigh.finalDecision).toBe('SURFACE'); // Not suppressed!
        expect(resultHigh.decisionSource).toBe('POLICY');

        const resultCritical = evaluateFinding({ ruleId: 'sql-injection', severity: 'CRITICAL' });
        expect(resultCritical.finalDecision).toBe('SURFACE');
    });

    it('Security Floor: allows SURFACE rules on HIGH findings', () => {
        mockRules.push({ id: 'rule3', ruleId: 'sql-injection', action: 'SURFACE' });

        const resultHigh = evaluateFinding({ ruleId: 'sql-injection', severity: 'HIGH' });
        expect(resultHigh.finalDecision).toBe('SURFACE');
        expect(resultHigh.decisionSource).toBe('OVERRIDE'); // Applied the rule successfully
    });

    it('Shadow Mode: does not mutate decision', () => {
        process.env.FEEDBACK_RULES = 'shadow';
        mockRules.push({ id: 'rule4', ruleId: 'no-console', action: 'SUPPRESS' });

        const result = evaluateFinding({ ruleId: 'no-console', severity: 'MEDIUM' });
        expect(result.finalDecision).toBe('SURFACE'); // Stays SURFACE
        expect(result.decisionSource).toBe('POLICY');
    });
});
