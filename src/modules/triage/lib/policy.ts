import { Finding, TriageDecision } from "@/generated/prisma/client";

export const TRIAGE_TAU_SURFACE = 0.60;
export const TRIAGE_TAU_SUPPRESS = 0.25;
export const POLICY_VERSION = 'policy-v0';

export function getPolicyDecision(finding: Finding): TriageDecision {
    const isHighOrCritical = finding.severity === 'HIGH' || finding.severity === 'CRITICAL';
    const isSecurity = finding.category === 'SECURITY';

    // HIGH/CRITICAL SECURITY -> ALWAYS SURFACE
    if (isHighOrCritical && isSecurity) {
        return "SURFACE";
    }

    const inChangedOrNew = finding.inChangedLines || !finding.isPreexisting;
    const isMediumOrHigher = finding.severity === 'MEDIUM' || finding.severity === 'HIGH' || finding.severity === 'CRITICAL';
    const isTargetCategory = finding.category === 'SECURITY' || finding.category === 'CORRECTNESS';

    if (inChangedOrNew && isMediumOrHigher && isTargetCategory) {
        return "SURFACE";
    }

    return "SUPPRESS";
}

/** The bar a score is measured against. Each model has its own; a model with one threshold uses it for both. */
export interface ScoreThresholds {
    showFrom: number;
    hideBelow: number;
}

export const DEFAULT_THRESHOLDS: ScoreThresholds = { showFrom: TRIAGE_TAU_SURFACE, hideBelow: TRIAGE_TAU_SUPPRESS };

export function getScoreRoutingDecision(score: number, thresholds: ScoreThresholds = DEFAULT_THRESHOLDS): TriageDecision {
    if (score >= thresholds.showFrom) return "SURFACE";
    if (score > thresholds.hideBelow && score < thresholds.showFrom) return "UNCERTAIN";
    return "SUPPRESS";
}

export function getFinalDecision(
    finding: Finding, 
    mode: 'policy' | 'shadow' | 'model', 
    mlScore?: number,
    thresholds: ScoreThresholds = DEFAULT_THRESHOLDS
): { finalDecision: TriageDecision, decisionSource: 'POLICY' | 'MODEL' | 'POLICY_FALLBACK' | 'POLICY_SEVERITY_FLOOR' | 'OVERRIDE' } {
    
    const policyDecision = getPolicyDecision(finding);

    if (mode === 'policy' || mode === 'shadow' || mlScore === undefined) {
        return { 
            finalDecision: policyDecision, 
            decisionSource: mlScore === undefined && mode === 'model' ? 'POLICY_FALLBACK' : 'POLICY' 
        };
    }

    // mode === 'model'
    const isHighOrCritical = finding.severity === 'HIGH' || finding.severity === 'CRITICAL';
    if (isHighOrCritical && finding.category === 'SECURITY') {
        // Safety floor overrides everything
        return { finalDecision: "SURFACE", decisionSource: 'POLICY_SEVERITY_FLOOR' };
    }

    // The risk score directly drives the decision (with UNCERTAIN as a valid final routing state)
    const scoreDecision = getScoreRoutingDecision(mlScore, thresholds);
    return { finalDecision: scoreDecision, decisionSource: 'MODEL' };
}
