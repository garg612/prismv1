import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyGitHubWebhookSignature } from '../../src/modules/github/lib/webhook-verify';
import { POST } from '../../src/app/api/webhooks/github/route';
import crypto from 'crypto';

// Mock inngest
vi.mock('@/inngest/client', () => ({
  inngest: {
    send: vi.fn().mockResolvedValue(true)
  }
}));

// Mock prisma
vi.mock('@/lib/db', () => ({
  default: {
    webhookEvent: {
      create: vi.fn().mockResolvedValue(true)
    }
  }
}));

import { inngest } from '@/inngest/client';

describe('Webhook Verification', () => {
  const secret = 'test-secret';
  const payload = JSON.stringify({ action: 'opened' });
  const hmac = crypto.createHmac('sha256', secret);
  const validSignature = `sha256=${hmac.update(payload).digest('hex')}`;

  it('accepts valid signature', () => {
    expect(verifyGitHubWebhookSignature(payload, validSignature, secret)).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(verifyGitHubWebhookSignature(payload, 'sha256=invalid', secret)).toBe(false);
  });

  it('rejects missing signature', () => {
    expect(verifyGitHubWebhookSignature(payload, null, secret)).toBe(false);
  });

  it('rejects modified body', () => {
    expect(verifyGitHubWebhookSignature(payload + ' ', validSignature, secret)).toBe(false);
  });
});

describe('Webhook Route Behavior', () => {
  const secret = 'test-secret';
  const payload = JSON.stringify({ 
      action: 'opened', 
      repository: { full_name: 'owner/repo', id: 123 }, 
      number: 1,
      pull_request: { head: { sha: 'sha123' } }
  });
  const hmac = crypto.createHmac('sha256', secret);
  const validSignature = `sha256=${hmac.update(payload).digest('hex')}`;

  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    vi.clearAllMocks();
  });

  const createRequest = (event: string, deliveryId: string | null = 'test-delivery-id') => {
    return {
      text: () => Promise.resolve(payload),
      headers: {
        get: (key: string) => {
          if (key === 'x-hub-signature-256') return validSignature;
          if (key === 'x-github-delivery') return deliveryId;
          if (key === 'x-github-event') return event;
          return null;
        }
      }
       
    } as any;
  };

  it('ignores unsupported event appropriately (ping)', async () => {
    const req = createRequest('ping');
    const res = await POST(req);
    expect(res.status).toBe(202);
  });

  it('awaits enqueue and returns 202 on success', async () => {
    const req = createRequest('pull_request');
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(inngest.send).toHaveBeenCalled();
  });

  it('handles duplicate delivery by skipping enqueue and returning 202', async () => {
    const { default: prisma } = await import('@/lib/db');
    
    // Request A
     
    (prisma.webhookEvent.create as any).mockResolvedValueOnce(true);
    const req1 = createRequest('pull_request', 'delivery-123');
    const res1 = await POST(req1);
    expect(res1.status).toBe(202);
    expect(inngest.send).toHaveBeenCalledTimes(1);

    // Request B (Duplicate)
     
    (prisma.webhookEvent.create as any).mockRejectedValueOnce(new Error('Unique constraint failed'));
    const req2 = createRequest('pull_request', 'delivery-123');
    const res2 = await POST(req2);
    expect(res2.status).toBe(202); 
    // Inngest should not be called again
    expect(inngest.send).toHaveBeenCalledTimes(1);

    // Request C (New Delivery)
     
    (prisma.webhookEvent.create as any).mockResolvedValueOnce(true);
    const req3 = createRequest('pull_request', 'delivery-456');
    const res3 = await POST(req3);
    expect(res3.status).toBe(202);
    expect(inngest.send).toHaveBeenCalledTimes(2);
  });
});
