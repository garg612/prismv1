import { prisma } from '../src/lib/db';
async function run() {
    const runId = '7b3fdda4-8868-4e58-b20b-448b29fa3095';
    // Warm up
    await prisma.reviewRun.findFirst({ where: { id: runId } });
    const start = Date.now();
    const res = await prisma.reviewRun.findFirst({
        where: { id: runId },
        relationLoadStrategy: 'query',
        include: {
            pullRequest: true,
            repository: true,
            scanRuns: true,
            findings: {
                orderBy: [{ severity: "desc" }, { filePath: "asc" }, { startLine: "asc" }],
                include: {
                    classifications: true,
                    feedback: { select: { kind: true, createdAt: true } },
                    fixes: {
                        include: {
                            patch: true,
                            applyAttempts: true,
                            validationRuns: { include: { validationResults: true, findingDeltas: true } }
                        }
                    }
                }
            }
        }
    } as any);
    console.log('Query with strategy query took:', Date.now() - start, 'ms');
}
run();
