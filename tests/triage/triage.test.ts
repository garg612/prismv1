import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callMLService } from '../../src/modules/triage/lib/http-classifier';
import { getFinalDecision, getPolicyDecision } from '../../src/modules/triage/lib/policy';
import { Finding, TriageDecision } from "@/generated/prisma/client";

describe('Triage ML Tests', () => {
    
    beforeEach(() => {
        vi.stubEnv('ML_SERVICE_URL', 'https://mock.example.com/api/v1/predict');
        vi.stubEnv('ML_HMAC_SECRET', 'test_secret');
        vi.stubEnv('ML_ACCEPTED_MODEL_VERSIONS', 'prism-exp2-ensemble-v1.0');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('validates ML HTTP Client schema successfully', async () => {
        const mockResponse = {
            finding_id: 'STAGE4-TEST-001',
            risk_score: 0.690305,
            decision: 'SURFACE',
            threshold: 0.2,
            model_version: 'prism-exp2-ensemble-v1.0',
            dataset_version: 'v0.2',
            feature_version: 'structured-plus-code-tfidf-sanitized-v1',
            component_scores: { lr: 0.38, rf: 0.87, xgb: 0.81 }
        };

        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockResponse)));

        const res = await callMLService([{ finding_id: 'STAGE4-TEST-001' } as any]);
        expect(res).toHaveLength(1);
        expect(res[0].ok).toBe(true);
        if (!res[0].ok) throw new Error('expected a prediction');
        expect(res[0].response.risk_score).toBe(0.690305);
        expect(res[0].response.decision).toBe('SURFACE');

        fetchSpy.mockRestore();
    });

    it('rejects unknown model version with an explicit error result', async () => {
        const mockResponse = {
            finding_id: 'STAGE4-TEST-001',
            risk_score: 0.5,
            decision: 'SURFACE',
            threshold: 0.2,
            model_version: 'unknown-v2.0',
            dataset_version: 'v0.2',
            feature_version: 'structured-plus-code-tfidf-sanitized-v1',
            component_scores: { lr: 0.5, rf: 0.5, xgb: 0.5 }
        };

        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockResponse)));

        const res = await callMLService([{ finding_id: 'STAGE4-TEST-001' } as any]);
        // The finding is not dropped: it comes back as an explicit failure, never as a score
        expect(res).toHaveLength(1);
        expect(res[0].ok).toBe(false);
        if (res[0].ok) throw new Error('expected a failure');
        expect(res[0].error).toContain('Unsupported model version');

        fetchSpy.mockRestore();
    });

    it('routes findings according to Policy v0 bounds', () => {
        const suppressF = { severity: 'LOW', category: 'STYLE', inChangedLines: true, isPreexisting: false } as Finding;
        expect(getPolicyDecision(suppressF)).toBe('SUPPRESS');

        const surfaceF = { severity: 'HIGH', category: 'SECURITY', inChangedLines: true, isPreexisting: false } as Finding;
        expect(getPolicyDecision(surfaceF)).toBe('SURFACE');

        const criticalPreF = { severity: 'CRITICAL', category: 'SECURITY', inChangedLines: false, isPreexisting: true } as Finding;
        expect(getPolicyDecision(criticalPreF)).toBe('SURFACE'); // floor

        const mediumCorrect = { severity: 'MEDIUM', category: 'CORRECTNESS', inChangedLines: true, isPreexisting: false } as Finding;
        expect(getPolicyDecision(mediumCorrect)).toBe('SURFACE'); 
    });

    it('Shadow mode returns POLICY route and tracks disagreement', () => {
        const finding = { severity: 'LOW', category: 'STYLE', inChangedLines: true, isPreexisting: false } as Finding;
        const result = getFinalDecision(finding, 'shadow', 0.99); // Model says highly risky

        expect(result.finalDecision).toBe('SUPPRESS');
        expect(result.decisionSource).toBe('POLICY');
    });

    it('Model mode routes with score thresholds safely', () => {
        const finding = { severity: 'LOW', category: 'STYLE', inChangedLines: true, isPreexisting: false } as Finding;
        
        // ML score 0.61 -> Surface (>= 0.60)
        let result = getFinalDecision(finding, 'model', 0.61);
        expect(result.finalDecision).toBe('SURFACE');
        expect(result.decisionSource).toBe('MODEL');

        // ML score 0.26 -> Uncertain (0.25 < x < 0.60)
        result = getFinalDecision(finding, 'model', 0.26);
        expect(result.finalDecision).toBe('UNCERTAIN'); 
        expect(result.decisionSource).toBe('MODEL'); 

        // ML score 0.1 -> Suppress (<= 0.25)
        result = getFinalDecision(finding, 'model', 0.1);
        expect(result.finalDecision).toBe('SUPPRESS');
        expect(result.decisionSource).toBe('MODEL');
    });

    it('Severity floor overrides model routing', () => {
        const criticalSecurity = { severity: 'CRITICAL', category: 'SECURITY', inChangedLines: false, isPreexisting: true } as Finding;
        
        // Model says completely safe (0.01)
        const result = getFinalDecision(criticalSecurity, 'model', 0.01);
        expect(result.finalDecision).toBe('SURFACE');
        expect(result.decisionSource).toBe('POLICY_SEVERITY_FLOOR');
    });

    it('Explicit Model Cases A, B, C, D', () => {
        const finding = { severity: 'LOW', category: 'STYLE', inChangedLines: true, isPreexisting: false } as Finding;
        
        // Case A: risk_score = 0.10, model decision = SURFACE (ignored) -> SUPPRESS
        let result = getFinalDecision(finding, 'model', 0.10);
        expect(result.finalDecision).toBe('SUPPRESS');
        
        // Case B: risk_score = 0.70, model decision = SUPPRESS (ignored) -> SURFACE
        result = getFinalDecision(finding, 'model', 0.70);
        expect(result.finalDecision).toBe('SURFACE');
        
        // Case C: risk_score = 0.40 -> UNCERTAIN
        result = getFinalDecision(finding, 'model', 0.40);
        expect(result.finalDecision).toBe('UNCERTAIN');
        
        // Case D: HIGH SECURITY, risk_score = 0 -> SURFACE
        const highSecurity = { severity: 'HIGH', category: 'SECURITY', inChangedLines: true, isPreexisting: false } as Finding;
        result = getFinalDecision(highSecurity, 'model', 0);
        expect(result.finalDecision).toBe('SURFACE');

        // Case E: Use the actual live result risk_score = 0.591586
        result = getFinalDecision(finding, 'model', 0.591586);
        expect(result.finalDecision).toBe('UNCERTAIN');
    });
});

import { buildMLFeatures } from '../../src/modules/triage/lib/features';

describe('Feature Builder Tests', () => {
    it('Returns valid payload when all features are present', () => {
        const finding = { 
            id: 'F-001', 
            ruleId: 'test-rule',
            severity: 'LOW',
            filePath: 'index.ts',
            codeSnippet: 'A'.repeat(1000),
            metadata: {
                prism_features: {
                    fileSizeLines: 120,
                    functionLength: 20,
                    cyclomaticComplexity: 5
                }
            }
        } as unknown as Finding;
        
        const prChangedLines = 10;
        const features1 = buildMLFeatures(finding, prChangedLines, 0.2, 5, 0.4);
        
        expect(features1).not.toBeNull();
        expect(features1!.file_size_lines).toBe(120);
        expect(features1!.function_length).toBe(20);
        expect(features1!.cyclomatic_complexity).toBe(5);
        expect(features1!.historical_rule_fp_rate).toBe(0.2);
        expect(features1!.file_churn_90d).toBe(5);
        expect(features1!.repo_finding_density_per_1k_loc).toBe(0.4);
        expect(features1!.pr_changed_lines).toBe(10);
        expect(features1!.pr_change_code.length).toBe(500); // capped
    });

    it('Explicitly blocks routing (returns null) for unavailable features', () => {
        const finding = { 
            id: 'F-001', 
            ruleId: 'test-rule',
            severity: 'LOW',
            filePath: 'index.ts',
            codeSnippet: 'A'.repeat(1000),
            metadata: {
                prism_features: {
                    fileSizeLines: 120,
                    functionLength: null, // missing AST feature
                    cyclomaticComplexity: 5
                }
            }
        } as unknown as Finding;
        
        const prChangedLines = 10;
        
        // Due to lack of robust AST parsing for functionLength, it should return null
        const features1 = buildMLFeatures(finding, prChangedLines, 0.2, 5, 0.4);
        
        expect(features1).toBeNull();
    });
});
