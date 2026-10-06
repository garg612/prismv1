import { prisma } from '../src/lib/db';
async function run() {
    const runId = '7b3fdda4-8868-4e58-b20b-448b29fa3095';
    const count = await prisma.finding.count({ where: { reviewRunId: runId } });
    console.log('Findings count:', count);
}
run();
