import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaselineCache } from '../../services/runner/src/baseline-cache';
import { buildSemgrepDockerArgs } from '../../services/runner/src/semgrep';
import type { ExecValidateResult } from '../../services/runner/src/exec-validate';

const completed = (id: string): ExecValidateResult => ({
    jobId: id, sandboxId: `sbx-${id}`, provider: 'e2b', templateId: 'base', commandsHash: 'h', destroyed: true, totalDuration: 1,
    results: { INSTALL: { status: 'PASSED', duration: 1 }, TEST: { status: 'PASSED', duration: 1 } },
});
const errored = (id: string): ExecValidateResult => ({
    jobId: id, provider: 'e2b', templateId: 'base', commandsHash: 'h', destroyed: true, totalDuration: 1, error: 'SANDBOX_ERROR: boom',
});

let treeA: string;
let treeB: string;
beforeAll(() => {
    treeA = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-a-'));
    treeB = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-b-'));
    fs.writeFileSync(path.join(treeA, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
    fs.writeFileSync(path.join(treeB, 'package.json'), JSON.stringify({ scripts: { test: 'node other.js' } }));
});
afterAll(() => {
    fs.rmSync(treeA, { recursive: true, force: true });
    fs.rmSync(treeB, { recursive: true, force: true });
});

describe('baseline cache: one "before the fix" run per commit', () => {
    it('four fixes validated at once share a single baseline run', async () => {
        const cache = new BaselineCache();
        let runs = 0;
        const run = async () => { runs++; await new Promise(r => setTimeout(r, 20)); return completed(`run-${runs}`); };

        const results = await Promise.all([1, 2, 3, 4].map(() => cache.get('repo:sha1', treeA, run)));

        expect(runs).toBe(1);
        expect(new Set(results.map(r => r.sandboxId)).size).toBe(1);
        // A later fix for the same commit reuses it too
        await cache.get('repo:sha1', treeA, run);
        expect(runs).toBe(1);
    });

    it('a different commit, or different commands for the same key, gets its own run', async () => {
        const cache = new BaselineCache();
        let runs = 0;
        const run = async () => completed(`run-${++runs}`);

        await cache.get('repo:sha1', treeA, run);
        await cache.get('repo:sha2', treeA, run);
        await cache.get('repo:sha1', treeB, run);

        expect(runs).toBe(3);
    });

    it('a failed baseline is never reused, and waiting jobs do not inherit the failure', async () => {
        const cache = new BaselineCache();
        let runs = 0;
        const run = async () => {
            const n = ++runs;
            await new Promise(r => setTimeout(r, 20));
            return n === 1 ? errored('first') : completed(`run-${n}`);
        };

        const [first, second, third] = await Promise.all([1, 2, 3].map(() => cache.get('repo:sha1', treeA, run)));

        expect(first.error).toMatch(/SANDBOX_ERROR/);
        expect(second.error).toBeUndefined();
        expect(third.error).toBeUndefined();
        expect(runs).toBe(3);
        expect(cache.size).toBe(0);
    });

    it('a run that throws is dropped and the error reaches only its own caller', async () => {
        const cache = new BaselineCache();
        await expect(cache.get('repo:sha1', treeA, async () => { throw new Error('crash'); })).rejects.toThrow('crash');
        expect(cache.size).toBe(0);
        expect((await cache.get('repo:sha1', treeA, async () => completed('ok'))).sandboxId).toBe('sbx-ok');
    });

    it('without a key nothing is shared', async () => {
        const cache = new BaselineCache();
        let runs = 0;
        const run = async () => completed(`run-${++runs}`);
        await cache.get(undefined, treeA, run);
        await cache.get(undefined, treeA, run);
        expect(runs).toBe(2);
        expect(cache.size).toBe(0);
    });

    it('entries expire and the cache stays bounded', async () => {
        let now = 1_000;
        const cache = new BaselineCache(60_000, 2, () => now);
        let runs = 0;
        const run = async () => completed(`run-${++runs}`);

        await cache.get('repo:sha1', treeA, run);
        now += 61_000;
        await cache.get('repo:sha1', treeA, run);
        expect(runs).toBe(2);

        await cache.get('repo:sha2', treeA, run);
        await cache.get('repo:sha3', treeA, run);
        await cache.get('repo:sha4', treeA, run);
        expect(cache.size).toBeLessThanOrEqual(2);
    });
});

describe('semgrep invocation', () => {
    it('never waits on a version check, and still has no network', () => {
        const args = buildSemgrepDockerArgs('/work/repo', '/rules/r.yaml', 'c1', 'semgrep/semgrep:test');
        expect(args).toContain('--disable-version-check');
        expect(args[args.indexOf('-e') + 1]).toBe('SEMGREP_ENABLE_VERSION_CHECK=0');
        expect(args[args.indexOf('--network') + 1]).toBe('none');
        // Flags for docker come before the image; flags for semgrep after it
        expect(args.indexOf('-e')).toBeLessThan(args.indexOf('semgrep/semgrep:test'));
        expect(args.indexOf('--disable-version-check')).toBeGreaterThan(args.indexOf('semgrep/semgrep:test'));
        expect(args[args.length - 1]).toBe('.');
    });
});
