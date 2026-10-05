import { describe, it, expect, vi } from 'vitest';
import { POST } from '../../src/app/api/runner/callback/route';
import { signHmac } from '../../src/modules/runner/lib/client';

vi.mock('@/inngest/client', () => ({
    inngest: { send: vi.fn() }
}));

vi.mock('@/lib/db', () => ({
    default: {
        scanRun: {
            findUnique: vi.fn().mockResolvedValue({ id: 'id', status: 'PENDING' })
        }
    }
}));

describe('Runner callback tests', () => {
    it('rejects missing signature', async () => {
        const req = new Request('http://localhost:3000/api/runner/callback', {
            method: 'POST',
            body: JSON.stringify({}),
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
    });

    it('rejects invalid signature', async () => {
        process.env.RUNNER_CALLBACK_SECRET = 'secret';
        const req = new Request('http://localhost:3000/api/runner/callback', {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { 'x-runner-callback-signature': 'invalid' }
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
    });

    it('rejects expired timestamp', async () => {
        process.env.RUNNER_CALLBACK_SECRET = 'secret';
        const payload = JSON.stringify({ scanRunId: 'id', status: 'COMPLETED', timestamp: Date.now() - 10 * 60 * 1000 });
        const signature = signHmac(payload, 'secret');
        const req = new Request('http://localhost:3000/api/runner/callback', {
            method: 'POST',
            body: payload,
            headers: { 'x-runner-callback-signature': signature }
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
    });

    it('accepts valid callback', async () => {
        process.env.RUNNER_CALLBACK_SECRET = 'secret';
        const payload = JSON.stringify({ scanRunId: 'id', status: 'COMPLETED', timestamp: Date.now() });
        const signature = signHmac(payload, 'secret');
        const req = new Request('http://localhost:3000/api/runner/callback', {
            method: 'POST',
            body: payload,
            headers: { 'x-runner-callback-signature': signature }
        });
        const res = await POST(req);
        expect(res.status).toBe(202);
    });
});
