import { describe, it, expect, beforeEach, vi } from 'vitest';
import { aggregateMetrics } from '../../src/inngest/functions/aggregate-metrics';

const db = vi.hoisted(() => ({
    feedback: [] as any[],
    users: [] as any[],
    snapshots: [] as any[]
}));

vi.mock('../../src/lib/db', () => {
    const client = {
        user: {
            findMany: vi.fn(async ({ where }: any) => db.users.filter((u: any) => u.email.includes("demo")))
        },
        findingFeedback: {
            groupBy: vi.fn(async ({ by, where, _count }: any) => {
                const filtered = db.feedback.filter((f: any) => !where.userId.notIn.includes(f.userId) && where.kind.in.includes(f.kind));
                
                if (_count) {
                    const counts: any = {};
                    for (const f of filtered) {
                        counts[f.kind] = (counts[f.kind] || 0) + 1;
                    }
                    return Object.entries(counts).map(([kind, count]) => ({ kind, _count: { id: count } }));
                } else {
                    const users = new Set(filtered.map((f: any) => f.userId));
                    return Array.from(users).map(userId => ({ userId }));
                }
            })
        },
        globalMetricSnapshot: {
            create: vi.fn(async ({ data }: any) => {
                db.snapshots.push(data);
                return data;
            })
        },
        $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(client) : Promise.all(arg)))
    };
    return { default: client, prisma: client };
});

beforeEach(() => {
    db.feedback = [];
    db.users = [{ id: 'demo1', email: 'demo@example.com' }, { id: 'user1', email: 'real@example.com' }, { id: 'user2', email: 'real2@example.com' }];
    db.snapshots = [];
});

describe('aggregateMetrics', () => {
    it('calculates metrics excluding demo users', async () => {
        db.feedback = [
            // User 1
            { userId: 'user1', kind: 'FIX_ACCEPTED' },
            { userId: 'user1', kind: 'FIX_ACCEPTED' },
            { userId: 'user1', kind: 'FIX_REJECTED' },
            { userId: 'user1', kind: 'FALSE_POSITIVE' },
            { userId: 'user1', kind: 'TRUE_POSITIVE' },
            
            // User 2
            { userId: 'user2', kind: 'FIX_ACCEPTED' },
            { userId: 'user2', kind: 'FALSE_POSITIVE' },
            
            // Demo User (should be ignored)
            { userId: 'demo1', kind: 'FIX_REJECTED' },
            { userId: 'demo1', kind: 'FALSE_POSITIVE' },
        ];

        // We can just invoke the inner logic by mocking step.run
        const step = { run: vi.fn(async (name, fn) => fn()) };
        await (aggregateMetrics as any).fn({ step });

        expect(db.snapshots).toHaveLength(3);
        
        const fixSnapshot = db.snapshots.find((s: any) => s.metric === 'FIX_ACCEPTANCE_RATE');
        expect(fixSnapshot).toBeDefined();
        // Accepted: 3 (user1: 2, user2: 1), Rejected: 1 (user1: 1) -> Total: 4
        expect(fixSnapshot.numerator).toBe(3);
        expect(fixSnapshot.denominator).toBe(4);
        expect(fixSnapshot.value).toBe(75);
        expect(fixSnapshot.accountCount).toBe(2);

        const fpSnapshot = db.snapshots.find((s: any) => s.metric === 'FALSE_ALARM_RATE');
        expect(fpSnapshot).toBeDefined();
        // FP: 2 (user1: 1, user2: 1), TP: 1 (user1: 1) -> Total: 3
        expect(fpSnapshot.numerator).toBe(2);
        expect(fpSnapshot.denominator).toBe(3);
        expect(fpSnapshot.value).toBeCloseTo(66.66, 1);
        expect(fpSnapshot.accountCount).toBe(2);
    });
});
