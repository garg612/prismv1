import { BLOCKED_EGRESS_RANGES, SandboxFactory, SandboxLike } from '../../src/exec-validate';

/**
 * TEST-ONLY sandbox. Every command exits 0 and isolation reads back as established.
 * It exists so the gating logic around the sandbox (script safety checks, missing
 * scripts, teardown) can be exercised without E2B. It proves nothing about real
 * execution and must never be reachable from production code.
 */
export function createFakeSandbox(): SandboxLike & { killed: boolean; commandLog: string[] } {
    const sandbox = {
        sandboxId: 'fake-test-sandbox',
        killed: false,
        commandLog: [] as string[],
        commands: {
            run: async (cmd: string) => {
                sandbox.commandLog.push(cmd);
                if (cmd.startsWith('iptables -S')) {
                    return {
                        exitCode: 0,
                        stdout: BLOCKED_EGRESS_RANGES.map(r => `-A OUTPUT -d ${r} -j REJECT --reject-with icmp-port-unreachable`).join('\n'),
                        stderr: '',
                    };
                }
                return { exitCode: 0, stdout: '', stderr: '' };
            },
        },
        files: { write: async () => undefined },
        kill: async () => { sandbox.killed = true; },
    };
    return sandbox;
}

export const fakeSandboxFactory: SandboxFactory = async () => createFakeSandbox();
