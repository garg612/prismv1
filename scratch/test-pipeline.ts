import fs from "fs";
import dotenv from "dotenv";
import prisma from "../src/lib/db";
import { recordFeedback } from "../src/modules/review/lib/feedback";

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = "garg612/PRism-test-repo";

async function github(method: string, path: string, body?: any) {
    const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            "Authorization": `Bearer ${GITHUB_TOKEN}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
        throw new Error(`GitHub API Error: ${res.status} ${res.statusText} ${await res.text()}`);
    }
    return res.json();
}

async function createPR(branch: string, content: string, title: string) {
    console.log(`Creating PR ${title} on branch ${branch}...`);
    // 1. Get main SHA
    const mainRef = await github("GET", `/repos/${REPO}/git/ref/heads/main`);
    const mainSha = mainRef.object.sha;

    // 2. Create branch
    await github("POST", `/repos/${REPO}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: mainSha
    }).catch(e => console.log("Branch might already exist..."));

    // 3. Create blob
    const blob = await github("POST", `/repos/${REPO}/git/blobs`, {
        content,
        encoding: "utf-8"
    });

    // 4. Create tree
    const tree = await github("POST", `/repos/${REPO}/git/trees`, {
        base_tree: mainSha,
        tree: [{
            path: `test-${branch}.js`,
            mode: "100644",
            type: "blob",
            sha: blob.sha
        }]
    });

    // 5. Create commit
    const commit = await github("POST", `/repos/${REPO}/git/commits`, {
        message: title,
        tree: tree.sha,
        parents: [mainSha]
    });

    // 6. Update branch ref
    await github("PATCH", `/repos/${REPO}/git/refs/heads/${branch}`, {
        sha: commit.sha,
        force: true
    });

    // 7. Create PR
    const pr = await github("POST", `/repos/${REPO}/pulls`, {
        title,
        head: branch,
        base: "main"
    });

    console.log(`-> PR created: ${pr.html_url}`);
    return pr;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForReviewRun(prNumber: number) {
    console.log(`Waiting for ReviewRun on PR #${prNumber} to complete...`);
    for (let i = 0; i < 30; i++) { // wait up to 30*2 = 60s
        const run = await prisma.reviewRun.findFirst({
            where: {
                pullRequest: { number: prNumber },
                status: { in: ["AWAITING_APPROVAL", "COMPLETED", "FAILED"] }
            },
            include: { pullRequest: { include: { repository: true } } }
        });
        if (run) {
            console.log(`-> ReviewRun finished with status: ${run.status}`);
            return run;
        }
        await sleep(2000);
    }
    throw new Error("Timeout waiting for ReviewRun");
}

async function main() {
    try {
        console.log("=== Autonomous Pipeline Test ===");

        // Test PR 1
        const pr1 = await createPR("test-rule-3", "console.log('hello world'); eval('dangerous');", "Test PR 3 - Intro Finding");
        const run1 = await waitForReviewRun(pr1.number);

        // Fetch findings
        const findings1 = await prisma.finding.findMany({ where: { reviewRunId: run1.id } });
        console.log(`Found ${findings1.length} findings.`);
        
        // Find one to suppress
        const findingToSuppress = findings1.find(f => f.triageDecision === "SURFACE");
        if (!findingToSuppress) {
            console.log("No surfaced finding to suppress. Aborting test.");
            return;
        }

        console.log(`Flagging finding [${findingToSuppress.ruleId}] as FALSE_POSITIVE...`);
        const result = await recordFeedback(run1.pullRequest.repository.userId, findingToSuppress.id, "FALSE_POSITIVE", "TOOL_ERROR");
        console.log("Feedback result:", result);

        // Verify rule was created
        const rule = await prisma.feedbackRule.findFirst({
            where: { ruleId: findingToSuppress.ruleId, scope: "REPOSITORY" }
        });
        console.log("Created FeedbackRule:", rule);

        // Test PR 2
        const pr2 = await createPR("test-rule-4", "console.log('hello world'); eval('dangerous');", "Test PR 4 - Verify Suppression");
        const run2 = await waitForReviewRun(pr2.number);

        // Fetch findings
        const findings2 = await prisma.finding.findMany({ where: { reviewRunId: run2.id } });
        
        const suppressedFinding = findings2.find(f => f.ruleId === findingToSuppress.ruleId);
        if (suppressedFinding) {
            console.log(`Finding triage decision: ${suppressedFinding.triageDecision}`);
            if (suppressedFinding.triageDecision === "SUPPRESS") {
                console.log("SUCCESS! The finding was automatically suppressed by the local rule.");
            } else {
                console.log("FAILURE. The finding was NOT suppressed.");
            }
        } else {
            console.log("Finding was not even generated in PR 2.");
        }

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
