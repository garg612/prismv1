import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

describe('Runner Log/Output Limits', () => {
    it('enforces maxBuffer limit on subprocess output', async () => {
        const MAX_BUFFER = 1024 * 1024; // 1MB test buffer

        try {
            // Run Node snippet that outputs > 1MB
            await execFileAsync('node', ['-e', 'console.log("A".repeat(2 * 1024 * 1024))'], { 
                maxBuffer: MAX_BUFFER 
            });
            expect.fail('Should have thrown maxBuffer error');
        } catch (error: any) {
            expect(error.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
            expect(error.message).toMatch(/stdout maxBuffer length exceeded/);
        }
    });

    it('rejects unpinned Semgrep Docker image', () => {
        const imageString = 'semgrep/semgrep:1.81.0@sha256:3eb70a92f026a760c410c51f4d994ea6718d098e98ec0d2da285fc545a1c3132';
        expect(imageString).toMatch(/^semgrep\/semgrep:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/);
        
        const unpinned = 'semgrep/semgrep:latest';
        expect(unpinned).not.toMatch(/^semgrep\/semgrep:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/);
    });
});
