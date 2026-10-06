import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionLimits {
    cpu: string;
    memory: string;
    disk: string;
    timeouts: {
        INSTALL: number;
        LINT: number;
        BUILD: number;
        TEST: number;
        TOTAL: number;
    }
}

export interface CheckResult {
    status: 'PASSED' | 'FAILED' | 'UNAVAILABLE' | 'UNVERIFIABLE' | 'TIMEOUT' | 'ERROR' | 'SKIPPED';
    exitCode?: number;
    duration: number;
    log?: string;
    error?: string;
    timedOut?: boolean;
}

export interface ExecValidateResult {
    jobId: string;
    sandboxId?: string;
    provider: string;
    templateId: string;
    runtimeVersion?: string;
    commandsHash: string;
    headSha?: string;
    results?: Record<string, CheckResult>;
    error?: string;
    /** The repository has nothing this validator can run. Not a failure: no sandbox was started. */
    notApplicable?: { code: NotApplicableCode; detail: string };
    destroyed: boolean;
    totalDuration: number;
}

/**
 * Why a repository cannot be execution-validated at all. These describe the repository,
 * not a malfunction: the same commit always gives the same answer.
 */
export type NotApplicableCode =
    | 'NO_PACKAGE_JSON'
    | 'NO_LOCKFILE'
    | 'INVALID_PACKAGE_JSON'
    | 'NO_SCRIPTS'
    | 'ONLY_UNSAFE_SCRIPTS';

export const EVIDENCE_SCRIPTS = ['lint', 'build', 'test'] as const;

export interface ComparisonOutcome {
    check: string;
    baseline: CheckResult;
    fixed: CheckResult;
    verdict: 'PRESERVED' | 'VALIDATION_FAILED' | 'INCIDENTAL' | 'INCONCLUSIVE' | 'UNAVAILABLE';
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_LIMITS: ExecutionLimits = {
    cpu: '2',
    memory: '4096',
    disk: '10g',
    timeouts: {
        INSTALL: 5 * 60 * 1000,
        LINT: 3 * 60 * 1000,
        BUILD: 8 * 60 * 1000,
        TEST: 10 * 60 * 1000,
        TOTAL: 20 * 60 * 1000,
    }
};

// Immutable provider identity — all EXEC_VALIDATE runs are reproducible/auditable from this
export const PROVIDER_IDENTITY = {
    provider: 'e2b',
    templateId: 'base',           // E2B base template (Firecracker microVM)
    sdkVersion: '1.x',            // @e2b/code-interpreter SDK
    isolationBoundary: 'Firecracker microVM (hardware VM boundary)',
};

// Rejected before reaching the sandbox at all.
// Shell operators are matched anywhere in the script.
const DANGEROUS_OPERATORS = ['&&', '||', ';', '|', '$(', '`', '>', '<', '\n', '\r'];
// Command names are matched as whole words, so "tsc --incremental" or "sync" is not mistaken for "nc".
const DANGEROUS_COMMANDS = /(^|[\s\/\\"'=])(curl|wget|sudo|docker|kubectl|ssh|scp|nc|netcat|powershell|cmd\.exe)(?=$|[\s"'])/i;
const DANGEROUS_INVOCATIONS = /(^|[\s\/\\"'=])(sh|bash|zsh|node)\s+(-c|-e|--eval)(?=$|[\s"'=])/i;

// Environment variables that MUST NOT be present in the guest
export const FORBIDDEN_ENV_VARS = [
    'GITHUB_TOKEN', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
    'DATABASE_URL', 'PINECONE_API_KEY', 'PINECONE_INDEX_NAME',
    'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
    'POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'E2B_API_KEY',
    'RUNNER_HMAC_SECRET', 'RUNNER_CALLBACK_SECRET',
    'BETTER_AUTH_SECRET',
];

// Allowed env vars inside the sandbox (explicit allowlist, everything else stripped)
const ALLOWED_SANDBOX_ENV: Record<string, string> = {
    CI: 'true',
    NODE_ENV: 'test',
    HOME: '/home/user',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/share/.config/yarn/global/node_modules/.bin',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isSafeScript(script: string | undefined): boolean {
    if (!script || typeof script !== 'string' || !script.trim()) return false;
    for (const operator of DANGEROUS_OPERATORS) {
        if (script.includes(operator)) return false;
    }
    return !DANGEROUS_COMMANDS.test(script) && !DANGEROUS_INVOCATIONS.test(script);
}

/**
 * Decide, from the checked-out tree alone, whether there is anything to execute.
 * Returns null when at least one of lint/build/test can be run.
 */
export function detectNotApplicable(workDir: string): { code: NotApplicableCode; detail: string } | null {
    const pkgPath = path.join(workDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        return { code: 'NO_PACKAGE_JSON', detail: 'No package.json at the repository root' };
    }
    let pkg: any;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
        return { code: 'INVALID_PACKAGE_JSON', detail: 'package.json is not valid JSON' };
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
        return { code: 'INVALID_PACKAGE_JSON', detail: 'package.json is not a JSON object' };
    }
    if (!fs.existsSync(path.join(workDir, 'package-lock.json'))) {
        return { code: 'NO_LOCKFILE', detail: 'No package-lock.json at the repository root' };
    }

    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const defined = EVIDENCE_SCRIPTS.filter(name => typeof scripts[name] === 'string' && scripts[name].trim());
    if (defined.length === 0) {
        return { code: 'NO_SCRIPTS', detail: 'package.json defines no lint, build or test script' };
    }
    if (!defined.some(name => isSafeScript(scripts[name]))) {
        return { code: 'ONLY_UNSAFE_SCRIPTS', detail: `Scripts refused: ${defined.join(', ')}` };
    }
    return null;
}

/**
 * Compute the commands hash for cache keying.
 * Hash is over the install command + all npm scripts that will be run.
 */
export function computeCommandsHash(pkg: { scripts?: Record<string, string> }): string {
    const scripts = pkg.scripts ?? {};
    const relevant = {
        install: 'npm ci --ignore-scripts',
        lint: scripts.lint ?? null,
        build: scripts.build ?? null,
        test: scripts.test ?? null,
    };
    return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

/**
 * Baseline cache key: (repositoryId, headSha, commandsHash)
 */
export function buildCacheKey(repositoryId: string, headSha: string, commandsHash: string): string {
    return `${repositoryId}::${headSha}::${commandsHash}`;
}

/** Compare two CheckResults deterministically */
export function compareResults(check: string, baseline: CheckResult, fixed: CheckResult): ComparisonOutcome {
    const b = baseline.status;
    const f = fixed.status;

    if (b === 'UNAVAILABLE' || f === 'UNAVAILABLE') {
        return { check, baseline, fixed, verdict: 'UNAVAILABLE' };
    }

    const bPass = b === 'PASSED';
    const fPass = f === 'PASSED';

    if (bPass && fPass) return { check, baseline, fixed, verdict: 'PRESERVED' };
    if (bPass && !fPass) return { check, baseline, fixed, verdict: 'VALIDATION_FAILED' };
    if (!bPass && fPass) return { check, baseline, fixed, verdict: 'INCIDENTAL' };
    return { check, baseline, fixed, verdict: 'INCONCLUSIVE' };
}

function redactLog(raw: string): string {
    return raw
        .substring(0, 1024 * 1024)                                // 1 MB cap
        .replace(/\x1B\[\d+m/g, '')                               // strip ANSI
        .replace(/(ghp|sg|sk|e2b)_[a-zA-Z0-9]{15,}/gi, '[REDACTED]') // token redaction
        .replace(/(DATABASE_URL|PASSWORD|SECRET|TOKEN|API_KEY)=[^\s]*/gi, '$1=[REDACTED]');
}

// ─── Sandbox abstraction ──────────────────────────────────────────────────────

export interface SandboxCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string;
}

/** The subset of the E2B sandbox this module uses. */
export interface SandboxLike {
    sandboxId: string;
    commands: { run(cmd: string, opts?: Record<string, unknown>): Promise<SandboxCommandResult> };
    files: { write(path: string, data: any): Promise<unknown> };
    kill(): Promise<unknown>;
}

export type SandboxFactory = () => Promise<SandboxLike>;

function e2bSandboxFactory(apiKey: string): SandboxFactory {
    return async () => {
        const { Sandbox } = await import('@e2b/code-interpreter');
        return (await Sandbox.create({ apiKey })) as unknown as SandboxLike;
    };
}

// ─── Network isolation ────────────────────────────────────────────────────────

/** Private and cloud-metadata ranges the guest must not reach. */
export const BLOCKED_EGRESS_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];

const ISOLATION_SCRIPT_PATH = '/tmp/prism-isolate.sh';

// Shipped as a file so no outer shell expands $DNS_IP / $2 before bash sees them.
export const ISOLATION_SCRIPT = [
    '#!/bin/bash',
    'set -euo pipefail',
    "DNS_IP=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)",
    'test -n "$DNS_IP"',
    'iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'iptables -A OUTPUT -o lo -j ACCEPT',
    // The sandbox control channel terminates on the host at a link-local address, inside a
    // blocked range. conntrack only starts tracking when the rule above loads it, so the
    // stream carrying this very command is untracked. Send output and give the host time
    // to acknowledge it, so the flow is ESTABLISHED before the REJECT rules exist.
    'echo conntrack-armed',
    'sleep 2',
    'iptables -A OUTPUT -p udp --dport 53 -d "$DNS_IP" -j ACCEPT',
    'iptables -A OUTPUT -p tcp --dport 53 -d "$DNS_IP" -j ACCEPT',
    ...BLOCKED_EGRESS_RANGES.map(range => `iptables -A OUTPUT -d ${range} -j REJECT`),
    '',
].join('\n');

export class IsolationError extends Error {}

/**
 * Install the egress rules and then read them back. Throws unless every blocked
 * range is confirmed present. There is no "proceed anyway": the caller must not
 * run repository code if this throws.
 */
export async function establishNetworkIsolation(sandbox: SandboxLike): Promise<void> {
    try {
        await sandbox.files.write(ISOLATION_SCRIPT_PATH, ISOLATION_SCRIPT);
        const apply = await sandbox.commands.run(`bash ${ISOLATION_SCRIPT_PATH}`, { user: 'root', timeoutMs: 15000 });
        if (apply.exitCode !== 0) {
            throw new IsolationError(`isolation script exited ${apply.exitCode}: ${(apply.stderr || '').slice(-300)}`);
        }

        const verify = await sandbox.commands.run('iptables -S OUTPUT', { user: 'root', timeoutMs: 10000 });
        if (verify.exitCode !== 0) {
            throw new IsolationError(`could not read back firewall rules (exit ${verify.exitCode})`);
        }
        const rules = verify.stdout || '';
        const missing = BLOCKED_EGRESS_RANGES.filter(range => !new RegExp(`-d ${range.replace(/[.\/]/g, '\\$&')}\\b.*-j REJECT`).test(rules));
        if (missing.length > 0) {
            throw new IsolationError(`egress rules not in effect for: ${missing.join(', ')}`);
        }
    } catch (e: any) {
        if (e instanceof IsolationError) throw e;
        throw new IsolationError(e?.message || 'unknown error while configuring isolation');
    }
}

// ─── Core sandbox execution ───────────────────────────────────────────────────

export async function runExecValidate(
    workDir: string,
    limitsInput?: Partial<ExecutionLimits>,
    opts?: { headSha?: string; repositoryId?: string; sandboxFactory?: SandboxFactory }
): Promise<ExecValidateResult> {
    const jobId = createHash('sha256').update(`${workDir}:${Date.now()}`).digest('hex').slice(0, 12);
    const limits = { ...DEFAULT_LIMITS, ...limitsInput, timeouts: { ...DEFAULT_LIMITS.timeouts, ...limitsInput?.timeouts } };
    const totalStart = Date.now();

    const pkgPath = path.join(workDir, 'package.json');

    // Nothing runnable in this tree: say so without starting a sandbox.
    const notApplicable = detectNotApplicable(workDir);
    if (notApplicable) {
        return {
            jobId,
            provider: PROVIDER_IDENTITY.provider,
            templateId: PROVIDER_IDENTITY.templateId,
            commandsHash: 'n/a',
            destroyed: true,
            totalDuration: Date.now() - totalStart,
            notApplicable,
        };
    }

    const pkg: { scripts?: Record<string, string> } = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const commandsHash = computeCommandsHash(pkg);
    const scripts = pkg.scripts ?? {};
    const results: Record<string, CheckResult> = {};

    // Fail closed: without a real sandbox nothing is executed and nothing is reported as passed.
    const apiKey = process.env.E2B_API_KEY;
    const createSandbox = opts?.sandboxFactory ?? (apiKey ? e2bSandboxFactory(apiKey) : null);
    if (!createSandbox) {
        return {
            jobId,
            provider: PROVIDER_IDENTITY.provider,
            templateId: PROVIDER_IDENTITY.templateId,
            commandsHash,
            headSha: opts?.headSha,
            destroyed: true,
            totalDuration: Date.now() - totalStart,
            error: 'EXECUTION_UNAVAILABLE: E2B_API_KEY is not configured; no checks were executed',
        };
    }

    let sandbox: SandboxLike | null = null;
    let destroyed = false;

    try {
        sandbox = await createSandbox();
        const sandboxId = sandbox.sandboxId;

        // Isolation comes first: no repository content or command touches the guest before it holds.
        try {
            await establishNetworkIsolation(sandbox);
        } catch (e: any) {
            try { await sandbox.kill(); destroyed = true; } catch { /* ignore */ }
            return {
                jobId,
                sandboxId,
                provider: PROVIDER_IDENTITY.provider,
                templateId: PROVIDER_IDENTITY.templateId,
                commandsHash,
                headSha: opts?.headSha,
                destroyed,
                totalDuration: Date.now() - totalStart,
                error: 'ISOLATION_FAILED: ' + e.message,
            };
        }

        // Upload workspace files into /home/user/workspace inside the microVM
        await sandbox.commands.run('mkdir -p /home/user/workspace', { timeoutMs: 10000 });
        // Upload workspace securely using a tarball to prevent command injection via malicious filenames
        const tarPath = path.join(os.tmpdir(), `workspace-${sandboxId}-${Date.now()}.tar.gz`);
        const tar = await import('tar');
        await tar.c({ gzip: true, cwd: workDir, file: tarPath }, ['.']);
        
        const tarContent = fs.readFileSync(tarPath);
        await sandbox.files.write('/tmp/workspace.tar.gz', tarContent as any);
        
        await sandbox.commands.run('mkdir -p /home/user/workspace && tar -xzf /tmp/workspace.tar.gz -C /home/user/workspace', { timeoutMs: 30000 });
        
        try { fs.unlinkSync(tarPath); } catch {}


        const checks = ['INSTALL', 'LINT', 'BUILD', 'TEST'] as const;
        let failedFast = false;

        for (const check of checks) {
            if (Date.now() - totalStart > limits.timeouts.TOTAL) {
                results[check] = { status: 'SKIPPED', duration: 0, error: 'Total job timeout exceeded' };
                continue;
            }
            if (failedFast) {
                results[check] = { status: 'UNAVAILABLE', duration: 0, error: 'Prerequisite failed' };
                continue;
            }

            let cmd: string;
            const timeout = limits.timeouts[check];

            if (check === 'INSTALL') {
                // Egress rules were installed and verified before the workspace was uploaded.
                cmd = 'npm ci --ignore-scripts';
            } else {
                const scriptName = check.toLowerCase();
                if (typeof scripts[scriptName] !== 'string' || !scripts[scriptName].trim()) {
                    results[check] = { status: 'UNAVAILABLE', duration: 0 };
                    continue;
                }
                if (!isSafeScript(scripts[scriptName])) {
                    results[check] = { status: 'UNVERIFIABLE', duration: 0, error: 'Script contains dangerous patterns' };
                    failedFast = true;
                    continue;
                }
                // Run normally without network namespaces, since iptables blocks private IP spaces.
                cmd = `npm run ${scriptName}`;
            }

            const startTime = Date.now();
            try {
                const proc = await sandbox.commands.run(cmd, {
                    cwd: '/home/user/workspace',
                    timeoutMs: timeout,
                    envs: { ...ALLOWED_SANDBOX_ENV },
                });

                const rawLog = `${proc.stdout}\n${proc.stderr}`;
                const cleanLog = redactLog(rawLog);

                if (proc.exitCode === 0) {
                    results[check] = { status: 'PASSED', exitCode: 0, duration: Date.now() - startTime, log: cleanLog };
                } else {
                    results[check] = {
                        status: 'FAILED',
                        exitCode: proc.exitCode ?? 1,
                        duration: Date.now() - startTime,
                        log: cleanLog,
                        error: proc.error ?? `Exit code ${proc.exitCode}`,
                    };
                    if (check === 'INSTALL' || check === 'BUILD') failedFast = true;
                }
            } catch (e: any) {
                const isTimeout = e.isTimeout || (e.message && e.message.toLowerCase().includes('timeout'));
                if (e.result && typeof e.result.exitCode === 'number') {
                    const rawLog = `${e.result.stdout || ''}\n${e.result.stderr || ''}`;
                    const cleanLog = redactLog(rawLog);
                    results[check] = {
                        status: 'FAILED',
                        exitCode: e.result.exitCode,
                        duration: Date.now() - startTime,
                        log: cleanLog,
                        error: e.result.error || e.message
                    };
                    if (check === 'INSTALL' || check === 'BUILD') failedFast = true;
                } else {
                    results[check] = {
                        status: isTimeout ? 'TIMEOUT' : 'ERROR',
                        exitCode: 1,
                        duration: Date.now() - startTime,
                        log: '',
                        error: e.message,
                        timedOut: isTimeout,
                    };
                    if (check === 'INSTALL' || check === 'BUILD') failedFast = true;
                }
            }
        }

        // Destroy sandbox immediately after job completes
        await sandbox.kill();
        destroyed = true;

        return {
            jobId,
            sandboxId,
            provider: PROVIDER_IDENTITY.provider,
            templateId: PROVIDER_IDENTITY.templateId,
            commandsHash,
            headSha: opts?.headSha,
            results,
            destroyed,
            totalDuration: Date.now() - totalStart,
        };
    } catch (e: any) {
        if (sandbox && !destroyed) {
            try { await sandbox.kill(); destroyed = true; } catch { /* ignore */ }
        }
        return {
            jobId,
            provider: PROVIDER_IDENTITY.provider,
            templateId: PROVIDER_IDENTITY.templateId,
            commandsHash,
            destroyed,
            totalDuration: Date.now() - totalStart,
            error: 'SANDBOX_ERROR: ' + e.message,
        };
    }
}

// ─── Baseline/Fixed comparison ────────────────────────────────────────────────

export function compareExecResults(
    baseline: ExecValidateResult,
    fixed: ExecValidateResult,
): { comparisons: ComparisonOutcome[]; overallVerdict: 'PRESERVED' | 'VALIDATION_FAILED' | 'INCONCLUSIVE' } {
    const checks = ['INSTALL', 'LINT', 'BUILD', 'TEST'];
    const comparisons: ComparisonOutcome[] = [];

    const unavailableResult: CheckResult = { status: 'UNAVAILABLE', duration: 0 };
    for (const check of checks) {
        const b = baseline.results?.[check] ?? unavailableResult;
        const f = fixed.results?.[check] ?? unavailableResult;
        comparisons.push(compareResults(check, b, f));
    }

    // Overall verdict: any VALIDATION_FAILED → fail; any INCONCLUSIVE (with baseline PASS) → inconclusive; else preserved
    if (comparisons.some(c => c.verdict === 'VALIDATION_FAILED')) {
        return { comparisons, overallVerdict: 'VALIDATION_FAILED' };
    }
    if (comparisons.some(c => c.verdict === 'INCONCLUSIVE' && c.baseline.status === 'PASSED')) {
        return { comparisons, overallVerdict: 'INCONCLUSIVE' };
    }
    return { comparisons, overallVerdict: 'PRESERVED' };
}
