/**
 * Stage 10: Production Feature Flags
 * 
 * Supports:
 * - Global flags (PIPELINE_V2, executionValidation)
 * - Per-repository overrides
 * - Safe defaults (existing behavior preserved)
 * - Security: flag changes cannot bypass security checks
 */

export interface FeatureFlagConfig {
    /** Global pipeline v2 flag */
    PIPELINE_V2: 'disabled' | 'enabled';
    /** Global execution validation */
    executionValidation: 'disabled' | 'enabled' | 'per_repository';
    /** Global holistic review */
    holisticReview: 'disabled' | 'enabled' | 'per_repository';
}

const DEFAULT_FLAGS: FeatureFlagConfig = {
    PIPELINE_V2: 'enabled',
    executionValidation: 'per_repository',
    holisticReview: 'per_repository',
};

let currentFlags: FeatureFlagConfig = { ...DEFAULT_FLAGS };

export function getFeatureFlags(): FeatureFlagConfig {
    return { ...currentFlags };
}

export function setFeatureFlags(flags: Partial<FeatureFlagConfig>): void {
    currentFlags = { ...currentFlags, ...flags };
}

export function resetFeatureFlags(): void {
    currentFlags = { ...DEFAULT_FLAGS };
}

/**
 * Check if execution validation is enabled for a given repository.
 * Resolution order:
 * 1. If global flag is 'disabled' → false (override everything)
 * 2. If global flag is 'enabled' → true (override per-repo)
 * 3. If global flag is 'per_repository' → use repository.executionValidation
 */
export function isExecutionValidationEnabled(repositoryFlag: boolean): boolean {
    const global = currentFlags.executionValidation;
    if (global === 'disabled') return false;
    if (global === 'enabled') return true;
    return repositoryFlag; // per_repository
}

/**
 * Check if holistic review is enabled for a given repository.
 */
export function isHolisticReviewEnabled(repositoryFlag: boolean): boolean {
    const global = currentFlags.holisticReview;
    if (global === 'disabled') return false;
    if (global === 'enabled') return true;
    return repositoryFlag;
}

/**
 * Check if pipeline v2 is active.
 */
export function isPipelineV2(): boolean {
    return currentFlags.PIPELINE_V2 === 'enabled';
}

/**
 * SECURITY INVARIANT: Feature flags NEVER bypass:
 * - HMAC verification
 * - Authentication
 * - Authorization / ownership checks
 * - Signature validation
 * - Input validation
 * - Sandbox isolation
 * 
 * Feature flags ONLY control:
 * - Which optional pipeline stages run
 * - Which validation tiers are active
 * - Which review modes are available
 */
