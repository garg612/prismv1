/**
 * Run `fn` over `items` with at most `limit` running at once.
 * Results come back in input order. The first rejection rejects the whole call,
 * exactly as a sequential loop would stop at its first throw; items not yet started are not run.
 */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
    let next = 0;
    let failed = false;

    const worker = async () => {
        while (!failed) {
            const index = next++;
            if (index >= items.length) return;
            try {
                results[index] = await fn(items[index], index);
            } catch (e) {
                failed = true;
                throw e;
            }
        }
    };

    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}
