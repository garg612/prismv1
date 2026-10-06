import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promoteGlobalRules } from '../../src/inngest/functions/promote-global-rules';

const db = vi.hoisted(() => ({
    feedbackRules: [] as any[],
    upserted: [] as any[],
    created: [] as any[],
    updated: [] as any[]
}));

vi.mock('../../src/lib/db', () => {
    return {
        default: {
            $queryRaw: vi.fn(async () => {
                // Mock returning 2 rules that have >= 5 independent accounts
                return [
                    { ruleId: 'rule1', fingerprint: 'fp1', action: 'SUPPRESS', uniqueAccounts: BigInt(5) },
                    { ruleId: 'rule2', fingerprint: null, action: 'SURFACE', uniqueAccounts: BigInt(10) }
                ];
            }),
            feedbackRule: {
                findFirst: vi.fn(async ({ where }: any) => {
                    return db.feedbackRules.find(r => r.ruleId === where.ruleId && r.fingerprint === where.fingerprint);
                }),
                create: vi.fn(async ({ data }: any) => {
                    db.created.push(data);
                    return { id: 'new-id', ...data };
                }),
                update: vi.fn(async ({ where, data }: any) => {
                    db.updated.push(data);
                    return { id: where.id, ...data };
                })
            }
        }
    };
});

describe('Promote Global Rules', () => {
    beforeEach(() => {
        db.feedbackRules = [];
        db.created = [];
        db.updated = [];
    });

    it('creates new PENDING global rules when threshold is met', async () => {
        const step = { run: vi.fn(async (name, fn) => fn()) };
        const result = await (promoteGlobalRules as any).fn({ step });
        
        expect(result.success).toBe(true);
        expect(db.created).toHaveLength(2);
        
        expect(db.created[0]).toEqual(expect.objectContaining({
            scope: 'GLOBAL',
            ruleId: 'rule1',
            fingerprint: 'fp1',
            status: 'PENDING',
            accountCount: 5
        }));
        
        expect(db.created[1]).toEqual(expect.objectContaining({
            scope: 'GLOBAL',
            ruleId: 'rule2',
            fingerprint: null,
            status: 'PENDING',
            accountCount: 10
        }));
    });

    it('updates existing global rules if they are already PENDING', async () => {
        db.feedbackRules = [
            { id: 'existing1', ruleId: 'rule1', fingerprint: 'fp1', scope: 'GLOBAL', status: 'PENDING' }
        ];

        const step = { run: vi.fn(async (name, fn) => fn()) };
        await (promoteGlobalRules as any).fn({ step });

        expect(db.updated).toHaveLength(1);
        expect(db.updated[0].accountCount).toBe(5);
        expect(db.created).toHaveLength(1); // rule2 is still created
    });
});
