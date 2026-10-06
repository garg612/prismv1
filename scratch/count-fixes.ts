import { prisma } from '../src/lib/db';
async function run() {
    const runId = '7b3fdda4-8868-4e58-b20b-448b29fa3095';
    const fixes = await prisma.suggestedFix.count({ where: { finding: { reviewRunId: runId } } });
    console.log('Fixes count:', fixes);
}
run();
