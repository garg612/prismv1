import "dotenv/config";
import { prisma } from "./src/lib/db";

async function main() {
    const repos = await prisma.repository.groupBy({
        by: ['owner', 'name'],
        _count: { id: true },
        having: { id: { _count: { gt: 1 } } }
    });
    console.log('Duplicates:', repos);
}

main().finally(() => process.exit(0));
