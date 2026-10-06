import { prisma } from '../src/lib/db';
async function run() {
    const res = await prisma.validationResult.findMany({
        where: { check: 'INSTALL' },
        orderBy: { id: 'desc' },
        take: 1,
    });
    console.log(JSON.stringify(res, null, 2));
}
run();
