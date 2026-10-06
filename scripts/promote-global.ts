import prisma from "../src/lib/db";
import readline from "readline";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query: string): Promise<string> => {
    return new Promise((resolve) => rl.question(query, resolve));
};

async function main() {
    console.log("=== PRism Global Rule Promotion ===");
    const pendingRules = await prisma.feedbackRule.findMany({
        where: { scope: 'GLOBAL', status: 'PENDING' }
    });

    if (pendingRules.length === 0) {
        console.log("No PENDING global rules to review.");
        process.exit(0);
    }

    console.log(`Found ${pendingRules.length} pending global rules:\n`);

    for (const rule of pendingRules) {
        console.log(`[Rule ${rule.id}]`);
        console.log(`  Rule ID:      ${rule.ruleId}`);
        console.log(`  Fingerprint:  ${rule.fingerprint || '(none)'}`);
        console.log(`  Action:       ${rule.action}`);
        console.log(`  Evidence:     ${rule.accountCount} independent accounts`);
        
        const answer = await question("Promote this rule to ACTIVE? (y/n/skip): ");
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
            await prisma.feedbackRule.update({
                where: { id: rule.id },
                data: { status: 'ACTIVE' }
            });
            console.log("-> Rule promoted to ACTIVE.\n");
        } else if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
            await prisma.feedbackRule.update({
                where: { id: rule.id },
                data: { status: 'REVOKED' }
            });
            console.log("-> Rule marked as REVOKED.\n");
        } else {
            console.log("-> Skipped.\n");
        }
    }

    console.log("Review complete.");
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
