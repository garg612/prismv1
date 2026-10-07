import prisma from "./src/lib/db";
async function seed() {
    const snapshots: any[] = [];
    const now = new Date();
    const periodStart = new Date(0);
    
    for(let i=0; i<10; i++) {
        const date = new Date(Date.now() - (10 - i) * 24 * 60 * 60 * 1000);
        snapshots.push({
            metric: 'FALSE_ALARM_RATE',
            value: 20 - i,
            numerator: 20 - i,
            denominator: 100,
            accountCount: 1,
            periodStart,
            periodEnd: date,
            createdAt: date
        });
        snapshots.push({
            metric: 'FIX_ACCEPTANCE_RATE',
            value: 70 + i * 2,
            numerator: 70 + i * 2,
            denominator: 100,
            accountCount: 1,
            periodStart,
            periodEnd: date,
            createdAt: date
        });
    }
    await prisma.globalMetricSnapshot.createMany({ data: snapshots });
    console.log('Seeded global metrics');
}
seed().finally(() => prisma.$disconnect());
