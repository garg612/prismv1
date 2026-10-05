import { describe, expect, it } from 'vitest';
import { mapWithLimit } from '../../src/lib/concurrency';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('mapWithLimit', () => {
    it('returns results in input order even when later items finish first', async () => {
        const out = await mapWithLimit([30, 5, 20, 1], 4, async (ms, i) => { await sleep(ms); return `${i}:${ms}`; });
        expect(out).toEqual(['0:30', '1:5', '2:20', '3:1']);
    });

    it('never runs more than the limit at once', async () => {
        let running = 0;
        let peak = 0;
        await mapWithLimit(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
            running++;
            peak = Math.max(peak, running);
            await sleep(3);
            running--;
        });
        expect(peak).toBe(4);
    });

    it('rejects on the first failure and does not start the remaining items', async () => {
        const started: number[] = [];
        const run = mapWithLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
            started.push(n);
            await sleep(5);
            if (n === 1) throw new Error('boom');
            return n;
        });
        await expect(run).rejects.toThrow('boom');
        await sleep(30);
        expect(started.length).toBeLessThan(8);
    });

    it('handles an empty list and a nonsensical limit', async () => {
        expect(await mapWithLimit([], 8, async () => 1)).toEqual([]);
        expect(await mapWithLimit([1, 2, 3], 0, async n => n * 2)).toEqual([2, 4, 6]);
        expect(await mapWithLimit([1, 2, 3], Number.NaN, async n => n * 2)).toEqual([2, 4, 6]);
    });
});
