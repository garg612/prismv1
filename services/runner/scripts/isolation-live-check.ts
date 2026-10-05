/**
 * Live check: establish network isolation in a real E2B sandbox and probe it.
 * Usage (from services/runner): npx tsx --env-file=../../.env isolation-live-check.ts
 */
import { Sandbox } from '@e2b/code-interpreter';
import { establishNetworkIsolation, SandboxLike } from '../src/exec-validate';

async function probe(sandbox: SandboxLike, label: string, cmd: string) {
    try {
        const r = await sandbox.commands.run(cmd, { timeoutMs: 20000 });
        console.log(`${label}: exit=${r.exitCode} out=${(r.stdout || '').trim().slice(0, 80)}`);
    } catch (e: any) {
        console.log(`${label}: exit=${e.exitCode ?? 'n/a'} blocked/failed (${String(e.message).split('\n')[0].slice(0, 80)})`);
    }
}

async function main() {
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) throw new Error('E2B_API_KEY not set');

    const sandbox = (await Sandbox.create({ apiKey })) as unknown as SandboxLike;
    console.log('sandbox', sandbox.sandboxId);
    try {
        await establishNetworkIsolation(sandbox);
        console.log('ISOLATION: established and verified');
        const rules = await sandbox.commands.run('iptables -S OUTPUT', { user: 'root', timeoutMs: 10000 });
        console.log(rules.stdout);
        await probe(sandbox, 'metadata 169.254.169.254', 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://169.254.169.254/');
        await probe(sandbox, 'private 10.0.0.1', 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://10.0.0.1/');
        await probe(sandbox, 'npm registry', 'curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://registry.npmjs.org/-/ping');
    } catch (e: any) {
        console.log('ISOLATION FAILED (fail-closed path):', e.message);
    } finally {
        await sandbox.kill();
        console.log('sandbox destroyed');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
