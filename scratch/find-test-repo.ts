import prisma from "../src/lib/db";

async function main() {
  const repo = await prisma.repository.findFirst({
    where: { name: { contains: "prism-test-repo" } }
  });
  console.log(repo);
}

main().catch(console.error).finally(() => prisma.$disconnect());
