import { describe, it, expect, beforeEach } from 'vitest';
import {
    getFeatureFlags,
    setFeatureFlags,
    resetFeatureFlags,
    isExecutionValidationEnabled,
    isHolisticReviewEnabled,
    isPipelineV2
} from '../../src/lib/feature-flags';

describe('Stage 10: Feature Flags', () => {
    beforeEach(() => {
        resetFeatureFlags();
    });

    it('defaults: PIPELINE_V2 = enabled', () => {
        expect(isPipelineV2()).toBe(true);
    });

    it('defaults: executionValidation = per_repository', () => {
        expect(getFeatureFlags().executionValidation).toBe('per_repository');
    });

    it('global disabled overrides per-repo true', () => {
        setFeatureFlags({ executionValidation: 'disabled' });
        expect(isExecutionValidationEnabled(true)).toBe(false);
    });

    it('global enabled overrides per-repo false', () => {
        setFeatureFlags({ executionValidation: 'enabled' });
        expect(isExecutionValidationEnabled(false)).toBe(true);
    });

    it('per_repository defers to repository flag', () => {
        setFeatureFlags({ executionValidation: 'per_repository' });
        expect(isExecutionValidationEnabled(true)).toBe(true);
        expect(isExecutionValidationEnabled(false)).toBe(false);
    });

    it('holistic review follows same resolution', () => {
        setFeatureFlags({ holisticReview: 'disabled' });
        expect(isHolisticReviewEnabled(true)).toBe(false);
        setFeatureFlags({ holisticReview: 'enabled' });
        expect(isHolisticReviewEnabled(false)).toBe(true);
        setFeatureFlags({ holisticReview: 'per_repository' });
        expect(isHolisticReviewEnabled(true)).toBe(true);
        expect(isHolisticReviewEnabled(false)).toBe(false);
    });

    it('reset restores all defaults', () => {
        setFeatureFlags({ PIPELINE_V2: 'disabled', executionValidation: 'enabled' });
        resetFeatureFlags();
        expect(isPipelineV2()).toBe(true);
        expect(getFeatureFlags().executionValidation).toBe('per_repository');
    });

    it('flags cannot be mutated externally', () => {
        const flags = getFeatureFlags();
        flags.PIPELINE_V2 = 'disabled';
        expect(isPipelineV2()).toBe(true); // still enabled
    });
});
