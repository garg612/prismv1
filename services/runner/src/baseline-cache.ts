import fs from 'fs';
import path from 'path';
import { computeCommandsHash, ExecValidateResult } from './exec-validate';

interface Entry {
    promise: Promise<ExecValidateResult>;
    storedAt: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50;

/** A baseline is reusable only if it actually ran to completion (or the tree has nothing to run). */
function isReusable(result: ExecValidateResult): boolean {
    if (result.error) return false;
    return !!result.notApplicable || !!result.results;
}

/**
 * Shares the "before the fix" execution run between fixes of the same commit.
 *
 * The unmodified tree is identical for every fix validated against one commit, so its
 * install/lint/build/test run gives the same answer each time. The first job runs it; jobs that
 * arrive while it is running wait for it; later jobs reuse it.
 *
 * Safety rules:
 *  - The key combines the caller's identity for the tree (repository + commit) with a hash of the
 *    commands that would run, read from the tree itself.
 *  - Only completed runs are kept. A run that errored (sandbox unavailable, isolation failed...)
 *    is dropped, and anyone who was waiting on it runs their own baseline instead of inheriting
 *    the failure.
 *  - Without a key nothing is shared.
 */
export class BaselineCache {
    private entries = new Map<string, Entry>();

    constructor(private ttlMs = DEFAULT_TTL_MS, private maxEntries = DEFAULT_MAX_ENTRIES, private now: () => number = Date.now) {}

    get size(): number {
        return this.entries.size;
    }

    private keyFor(baselineKey: string, workDir: string): string {
        let commandsHash = 'none';
        try {
            commandsHash = computeCommandsHash(JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8')));
        } catch { /* no readable package.json: the run itself reports that */ }
        return `${baselineKey}::${commandsHash}`;
    }

    private prune(): void {
        const cutoff = this.now() - this.ttlMs;
        for (const [key, entry] of this.entries) {
            if (entry.storedAt < cutoff) this.entries.delete(key);
        }
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    async get(baselineKey: string | undefined, workDir: string, run: () => Promise<ExecValidateResult>): Promise<ExecValidateResult> {
        if (!baselineKey) return run();

        this.prune();
        const key = this.keyFor(baselineKey, workDir);

        const existing = this.entries.get(key);
        if (existing) {
            const shared = await existing.promise.catch(() => null);
            if (shared && isReusable(shared)) return shared;
            // The shared run failed. Do not inherit the failure: run this job's own baseline.
            return run();
        }

        const promise = run();
        const entry: Entry = { promise, storedAt: this.now() };
        this.entries.set(key, entry);
        this.prune();
        try {
            const result = await promise;
            if (!isReusable(result) && this.entries.get(key) === entry) this.entries.delete(key);
            return result;
        } catch (e) {
            if (this.entries.get(key) === entry) this.entries.delete(key);
            throw e;
        }
    }
}
