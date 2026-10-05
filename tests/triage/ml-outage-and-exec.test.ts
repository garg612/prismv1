/**
 * P0 correctness gate — items 6, 7, 8:
 * ML, E2B execution and network isolation all fail closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    callMLService,
    getMLConfig,
    assertTriageConfig,
    resolveTriageMode,
    MLConfigError,
} from '../../src/modules/triage/lib/http-classifier';
import { buildMLFeatures } from '../../src/modules/triage/lib/features';
import { getFinalDecision } from '../../src/modules/triage/lib/policy';
import { decideExecutionOutcome } from '../../src/modules/validation/lib/exec-outcome';
import {
    runExecValidate,
    establishNetworkIsolation,
    IsolationError,
    BLOCKED_EGRESS_RANGES,
    ISOLATION_SCRIPT,
    SandboxLike,
} from '../../services/runner/src/exec-validate';

const VALID_RESPONSE = {
    finding_id: 'F1',
    risk_score: 0.71,
    decision: 'SURFACE',
    threshold: 0.2,
    model_version: 'prism-exp2-ensemble-v1.0',
    dataset_version: 'v0.2',
    feature_version: 'structured-plus-code-tfidf-sanitized-v1',
    component_scores: { lr: 0.5, rf: 0.8, xgb: 0.8 }
};

describe('P0-6 ML configuration fails closed', () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('missing HMAC secret throws and sends nothing', async () => {
        vi.stubEnv('ML_SERVICE_URL', 'https://ml.example.com/predict');
        vi.stubEnv('ML_HMAC_SECRET', '');
        const fetchSpy = vi.spyOn(global, 'fetch');

        await expect(callMLService([{ finding_id: 'F1' } as any])).rejects.toThrow(MLConfigError);
        await expect(callMLService([{ finding_id: 'F1' } as any])).rejects.toThrow(/ML_HMAC_SECRET/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('missing service URL throws and sends nothing (no default host)', async () => {
        vi.stubEnv('ML_SERVICE_URL', '');
        vi.stubEnv('ML_HMAC_SECRET', 'real-secret');
        const fetchSpy = vi.spyOn(global, 'fetch');

        await expect(callMLService([{ finding_id: 'F1' } as any])).rejects.toThrow(/ML_SERVICE_URL/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('an invalid URL is rejected', () => {
        vi.stubEnv('ML_SERVICE_URL', 'not a url');
        vi.stubEnv('ML_HMAC_SECRET', 'real-secret');
        expect(() => getMLConfig()).toThrow(MLConfigError);
    });

    it('model and shadow modes require ML config; policy mode does not', () => {
        vi.stubEnv('ML_SERVICE_URL', '');
        vi.stubEnv('ML_HMAC_SECRET', '');

        vi.stubEnv('TRIAGE_MODE', 'model');
        expect(() => assertTriageConfig()).toThrow(MLConfigError);
        vi.stubEnv('TRIAGE_MODE', 'shadow');
        expect(() => assertTriageConfig()).toThrow(MLConfigError);
        vi.stubEnv('TRIAGE_MODE', 'policy');
        expect(assertTriageConfig()).toBe('policy');
    });

    it('an unknown TRIAGE_MODE is rejected instead of being treated as some mode', () => {
        vi.stubEnv('TRIAGE_MODE', 'modle');
        expect(() => resolveTriageMode()).toThrow(MLConfigError);
    });

    it('production source has no default secret or default endpoint', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/modules/triage/lib/http-classifier.ts'), 'utf8');
        expect(src).not.toMatch(/\|\|\s*'secret'/);
        expect(src).not.toContain('onrender.com');
    });
});

describe('P0-6 ML outage is explicit, never a fabricated score', () => {
    beforeEach(() => {
        vi.stubEnv('ML_SERVICE_URL', 'https://ml.example.com/predict');
        vi.stubEnv('ML_HMAC_SECRET', 'real-secret');
        vi.stubEnv('ML_ACCEPTED_MODEL_VERSIONS', 'prism-exp2-ensemble-v1.0');
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('HTTP 503 yields ok:false with the reason', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
        const res = await callMLService([{ finding_id: 'F1' } as any]);
        expect(res).toEqual([{ finding_id: 'F1', ok: false, error: 'HTTP error 503' }]);
    });

    it('a network error yields ok:false', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        const res = await callMLService([{ finding_id: 'F1' } as any]);
        expect(res[0]).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
    });

    it('an out-of-range score is rejected', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ...VALID_RESPONSE, risk_score: 1.7 })));
        const res = await callMLService([{ finding_id: 'F1' } as any]);
        expect(res[0].ok).toBe(false);
    });

    it('a response for a different finding is rejected', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ...VALID_RESPONSE, finding_id: 'OTHER' })));
        const res = await callMLService([{ finding_id: 'F1' } as any]);
        expect(res[0]).toMatchObject({ ok: false });
    });

    it('accepts the live service vocabulary: "FILTER" is recorded as SUPPRESS', async () => {
        // Body captured from the deployed service on 2026-10-05
        const live = { finding_id: 'F1', risk_score: 0.194755, decision: 'FILTER', threshold: 0.2, model_version: 'prism-exp2-ensemble-v1.0', dataset_version: 'v0.2', feature_version: 'structured-plus-code-tfidf-sanitized-v1', component_scores: { lr: 0.078395, rf: 0.434162, xgb: 0.071707 } };
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(live)));
        const res = await callMLService([{ finding_id: 'F1' } as any]);
        expect(res[0].ok).toBe(true);
        if (!res[0].ok) return;
        expect(res[0].response.risk_score).toBe(0.194755);
        expect(res[0].response.decision).toBe('SUPPRESS');
    });

    it('an unknown decision value is still rejected', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ...VALID_RESPONSE, decision: 'MAYBE' })));
        const res = await callMLService([{ finding_id: 'F1' } as any]);
        expect(res[0].ok).toBe(false);
    });

    it('one failure does not hide or shift the other findings', async () => {
        vi.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
            const id = JSON.parse(init.body).finding_id;
            if (id === 'F1') return new Response('down', { status: 500 });
            return new Response(JSON.stringify({ ...VALID_RESPONSE, finding_id: id }));
        });
        const res = await callMLService([{ finding_id: 'F1' }, { finding_id: 'F2' }, { finding_id: 'F3' }] as any);
        expect(res.map(r => [r.finding_id, r.ok])).toEqual([['F1', false], ['F2', true], ['F3', true]]);
    });

    it('the request is signed with the configured secret', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(VALID_RESPONSE)));
        await callMLService([{ finding_id: 'F1' } as any]);
        const headers = (fetchSpy.mock.calls[0][1] as any).headers;
        expect(headers['X-PRism-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });

    it('without a score, model mode routes by policy and says so', () => {
        const finding = { severity: 'LOW', category: 'STYLE', inChangedLines: true, isPreexisting: false } as any;
        expect(getFinalDecision(finding, 'model', undefined)).toEqual({ finalDecision: 'SUPPRESS', decisionSource: 'POLICY_FALLBACK' });
    });

    it('the orchestrator records fallbacks with a reason code', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/inngest/functions/review-run.ts'), 'utf8');
        expect(src).toContain("'ML_UNAVAILABLE'");
        expect(src).toContain("'ML_FEATURES_UNAVAILABLE'");
        expect(src).toContain("decisionSource: fallback ? 'POLICY_FALLBACK' : decisionSource");
        expect(src).toContain('new PipelineFailure("TRIAGE", "ML_CONFIG_INVALID"');
    });
});

describe('P0-6 model features are measured or absent', () => {
    const finding = (prism_features: any) => ({
        id: 'F1', ruleId: 'r', severity: 'LOW', filePath: 'index.ts', codeSnippet: 'x', metadata: { prism_features }
    } as any);

    it('returns null when a structural feature was not measured', () => {
        expect(buildMLFeatures(finding({ fileSizeLines: 120, functionLength: null, cyclomaticComplexity: 5 }), 10, 0.2, 5, 0.4)).toBeNull();
        expect(buildMLFeatures(finding({ fileSizeLines: 120, functionLength: 20, cyclomaticComplexity: null }), 10, 0.2, 5, 0.4)).toBeNull();
        expect(buildMLFeatures(finding({ fileSizeLines: 0, functionLength: 20, cyclomaticComplexity: 5 }), 10, 0.2, 5, 0.4)).toBeNull();
        expect(buildMLFeatures(finding(undefined), 10, 0.2, 5, 0.4)).toBeNull();
    });

    it('passes measured values through unchanged', () => {
        const payload = buildMLFeatures(finding({ fileSizeLines: 120, functionLength: 20, cyclomaticComplexity: 5 }), 10, 0.2, 5, 0.4)!;
        expect([payload.file_size_lines, payload.function_length, payload.cyclomatic_complexity]).toEqual([120, 20, 5]);
    });
});

// ─── E2B ──────────────────────────────────────────────────────────────────────

function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-exec-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node test.js' } }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 2, packages: {} }));
    return dir;
}

function fakeSandbox(handler: (cmd: string) => { exitCode: number; stdout?: string; stderr?: string } | Error) {
    const commands: string[] = [];
    const sandbox: SandboxLike & { killed: boolean } = {
        sandboxId: 'fake-sbx-1',
        killed: false,
        commands: {
            run: async (cmd: string) => {
                commands.push(cmd);
                const out = handler(cmd);
                if (out instanceof Error) throw out;
                return { exitCode: out.exitCode, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
            }
        },
        files: { write: async () => undefined },
        kill: async () => { sandbox.killed = true; },
    };
    return { sandbox, commands };
}

const GOOD_RULES = BLOCKED_EGRESS_RANGES.map(r => `-A OUTPUT -d ${r} -j REJECT --reject-with icmp-port-unreachable`).join('\n');

describe('P0-7 missing E2B credentials never produce a pass', () => {
    let dir: string;
    beforeEach(() => { dir = makeRepo(); vi.stubEnv('E2B_API_KEY', ''); });
    afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

    it('returns EXECUTION_UNAVAILABLE with no check results at all', async () => {
        const r = await runExecValidate(dir);
        expect(r.error).toMatch(/^EXECUTION_UNAVAILABLE/);
        expect(r.results).toBeUndefined();
        expect(r.sandboxId).toBeUndefined();
        expect(JSON.stringify(r)).not.toContain('PASSED');
    });

    it('production source contains no mock executor', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../services/runner/src/exec-validate.ts'), 'utf8');
        expect(src).not.toMatch(/runMockExecValidate|\[MOCK\]|simulated pass|provider: 'mock'/);
    });
});

describe('P0-7 only real, passing execution validates a fix', () => {
    const check = (status: string) => ({ status });
    const all = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, check(v)]));

    it('nothing ran → UNVERIFIED, not FIXED', () => {
        const none = all({ INSTALL: 'UNAVAILABLE', LINT: 'UNAVAILABLE', BUILD: 'UNAVAILABLE', TEST: 'UNAVAILABLE' });
        expect(decideExecutionOutcome({ provider: 'e2b', baseline: none, fixed: none }).outcome).toBe('UNVERIFIED');
    });

    it('missing results → UNVERIFIED', () => {
        expect(decideExecutionOutcome(null).outcome).toBe('UNVERIFIED');
        expect(decideExecutionOutcome({ provider: 'e2b' }).outcome).toBe('UNVERIFIED');
    });

    it('only INSTALL passed → UNVERIFIED (installing dependencies proves nothing about the fix)', () => {
        const r = all({ INSTALL: 'PASSED', LINT: 'UNAVAILABLE', BUILD: 'UNAVAILABLE', TEST: 'UNAVAILABLE' });
        expect(decideExecutionOutcome({ provider: 'e2b', baseline: r, fixed: r }).outcome).toBe('UNVERIFIED');
    });

    it('all-PASSED results from a non-real provider → UNVERIFIED', () => {
        const r = all({ INSTALL: 'PASSED', LINT: 'PASSED', BUILD: 'PASSED', TEST: 'PASSED' });
        expect(decideExecutionOutcome({ provider: 'mock', baseline: r, fixed: r }).outcome).toBe('UNVERIFIED');
        expect(decideExecutionOutcome({ baseline: r, fixed: r }).outcome).toBe('UNVERIFIED');
    });

    it('tests pass before and after in a real sandbox → FIXED', () => {
        const r = all({ INSTALL: 'PASSED', TEST: 'PASSED' });
        expect(decideExecutionOutcome({ provider: 'e2b', baseline: r, fixed: r }).outcome).toBe('FIXED');
    });

    it('a regression → VALIDATION_FAILED', () => {
        const out = decideExecutionOutcome({
            provider: 'e2b',
            baseline: all({ INSTALL: 'PASSED', TEST: 'PASSED' }),
            fixed: all({ INSTALL: 'PASSED', TEST: 'FAILED' })
        });
        expect(out).toEqual({ outcome: 'VALIDATION_FAILED', reason: 'Regression in TEST' });
    });

    it('baseline already failing → INCONCLUSIVE', () => {
        const out = decideExecutionOutcome({
            provider: 'e2b',
            baseline: all({ INSTALL: 'PASSED', TEST: 'FAILED' }),
            fixed: all({ INSTALL: 'PASSED', TEST: 'PASSED' })
        });
        expect(out.outcome).toBe('INCONCLUSIVE');
    });

    it('the orchestrator marks a fix NOT_READY/UNVERIFIED when execution did not run', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/inngest/functions/process-finding.ts'), 'utf8');
        expect(src).toContain('Execution validation did not run');
        expect(src).toContain('data: { status: "NOT_READY", outcome: "UNVERIFIED", readyAt: new Date() }');
        expect(src).toContain('decideExecutionOutcome(execResults)');
    });
});

describe('P0-8 network isolation fails closed', () => {
    let dir: string;
    beforeEach(() => { dir = makeRepo(); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('the script stops on the first error and no outer shell can expand its variables', () => {
        expect(ISOLATION_SCRIPT).toContain('set -euo pipefail');
        expect(ISOLATION_SCRIPT).toContain('test -n "$DNS_IP"');
        for (const range of BLOCKED_EGRESS_RANGES) {
            expect(ISOLATION_SCRIPT).toContain(`iptables -A OUTPUT -d ${range} -j REJECT`);
        }
    });

    it('succeeds only when every blocked range is read back from the firewall', async () => {
        const { sandbox } = fakeSandbox(cmd => cmd.startsWith('iptables -S') ? { exitCode: 0, stdout: GOOD_RULES } : { exitCode: 0 });
        await expect(establishNetworkIsolation(sandbox)).resolves.toBeUndefined();
    });

    it('throws when the isolation script exits non-zero', async () => {
        const { sandbox } = fakeSandbox(cmd => cmd.startsWith('bash ') ? { exitCode: 4, stderr: 'iptables: Permission denied' } : { exitCode: 0, stdout: GOOD_RULES });
        await expect(establishNetworkIsolation(sandbox)).rejects.toThrow(IsolationError);
    });

    it('throws when the command itself throws (e.g. timeout)', async () => {
        const { sandbox } = fakeSandbox(cmd => cmd.startsWith('bash ') ? new Error('deadline_exceeded') : { exitCode: 0 });
        await expect(establishNetworkIsolation(sandbox)).rejects.toThrow(/deadline_exceeded/);
    });

    it('throws when the script "succeeded" but a rule is not actually in effect', async () => {
        const partial = GOOD_RULES.split('\n').filter(l => !l.includes('169.254.0.0/16')).join('\n');
        const { sandbox } = fakeSandbox(cmd => cmd.startsWith('iptables -S') ? { exitCode: 0, stdout: partial } : { exitCode: 0 });
        await expect(establishNetworkIsolation(sandbox)).rejects.toThrow(/169\.254\.0\.0\/16/);
    });

    it('when isolation fails, execution stops: no repo command runs, the sandbox is destroyed, nothing passes', async () => {
        const { sandbox, commands } = fakeSandbox(cmd => cmd.startsWith('bash ') ? { exitCode: 1, stderr: 'iptables v1.8: can\'t initialize' } : { exitCode: 0, stdout: GOOD_RULES });

        const r = await runExecValidate(dir, undefined, { sandboxFactory: async () => sandbox });

        expect(r.error).toMatch(/^ISOLATION_FAILED/);
        expect(r.results).toBeUndefined();
        expect(r.destroyed).toBe(true);
        expect(sandbox.killed).toBe(true);
        expect(commands.some(c => c.includes('npm'))).toBe(false);
        expect(commands.some(c => c.includes('workspace'))).toBe(false);
    });

    it('production source has no "proceed anyway" path', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../services/runner/src/exec-validate.ts'), 'utf8');
        expect(src).not.toMatch(/proceeding anyway/i);
        // Isolation is established before the workspace is uploaded
        expect(src.indexOf('await establishNetworkIsolation(sandbox)')).toBeLessThan(src.indexOf("'mkdir -p /home/user/workspace'"));
    });
});
