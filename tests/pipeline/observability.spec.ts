import { describe, it, expect } from 'vitest';
import { logPipelineEvent, logSandboxEvent, metrics } from '../../src/lib/observability';

describe('Stage 10: Observability', () => {
    it('logPipelineEvent emits structured JSON with required fields', () => {
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => logs.push(msg);

        logPipelineEvent({
            reviewRunId: 'rr-1',
            repositoryId: 'repo-1',
            prNumber: 42,
            headSha: 'abc123',
            stage: 'SCAN',
            status: 'COMPLETED',
            durationMs: 1234,
        });

        console.log = origLog;

        expect(logs.length).toBe(1);
        const parsed = JSON.parse(logs[0].replace('[prism] ', ''));
        expect(parsed.reviewRunId).toBe('rr-1');
        expect(parsed.repositoryId).toBe('repo-1');
        expect(parsed.prNumber).toBe(42);
        expect(parsed.headSha).toBe('abc123');
        expect(parsed.stage).toBe('SCAN');
        expect(parsed.status).toBe('COMPLETED');
        expect(parsed.durationMs).toBe(1234);
        expect(parsed.ts).toBeDefined();
    });

    it('logPipelineEvent redacts secrets in error messages', () => {
        const logs: string[] = [];
        const origErr = console.error;
        console.error = (msg: string) => logs.push(msg);

        logPipelineEvent({
            stage: 'CALLBACK',
            status: 'FAILED',
            error: 'Connection failed: postgres://user:pass@host/db token=ghp_abc123xyz',
        });

        console.error = origErr;

        const parsed = JSON.parse(logs[0].replace('[prism] ', ''));
        expect(parsed.error).not.toContain('postgres://');
        expect(parsed.error).not.toContain('ghp_abc123xyz');
        expect(parsed.error).toContain('[REDACTED]');
    });

    it('logPipelineEvent truncates error to 500 chars', () => {
        const logs: string[] = [];
        const origErr = console.error;
        console.error = (msg: string) => logs.push(msg);

        logPipelineEvent({
            stage: 'TEST',
            status: 'FAILED',
            error: 'x'.repeat(1000),
        });

        console.error = origErr;

        const parsed = JSON.parse(logs[0].replace('[prism] ', ''));
        expect(parsed.error.length).toBeLessThanOrEqual(500);
    });

    it('logSandboxEvent emits structured JSON', () => {
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => logs.push(msg);

        logSandboxEvent({
            provider: 'e2b',
            runtime: 'node:20',
            cpu: '2',
            memory: '512Mi',
            timeout: 300,
            exitCode: 0,
            checks: { INSTALL: 'PASSED', TEST: 'PASSED' },
        });

        console.log = origLog;

        const parsed = JSON.parse(logs[0].replace('[prism:sandbox] ', ''));
        expect(parsed.provider).toBe('e2b');
        expect(parsed.checks.INSTALL).toBe('PASSED');
    });

    it('metrics counters increment correctly', () => {
        const initial = metrics.webhookReceived;
        metrics.increment('webhookReceived');
        expect(metrics.webhookReceived).toBe(initial + 1);
    });

    it('metrics snapshot returns all numeric counters', () => {
        const snap = metrics.snapshot();
        expect(typeof snap.webhookReceived).toBe('number');
        expect(typeof snap.runnerJobsDispatched).toBe('number');
        expect(typeof snap.sandboxCreated).toBe('number');
        expect(snap.increment).toBeUndefined();
        expect(snap.snapshot).toBeUndefined();
    });
});
