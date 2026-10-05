import 'dotenv/config';
import prisma from '../../src/lib/db';
import { applyFixToGithub } from '../../src/modules/github/lib/apply-fix';
import { getGithubToken } from '../../src/modules/github/lib/github';
import { Octokit } from 'octokit';
import crypto from 'crypto';
import { test } from 'vitest';

test.skip('LIVE GITHUB E2E', async () => {
    console.log("Starting LIVE GITHUB E2E...");

    let user = await prisma.user.findFirst();
    if (!user) {
        user = await prisma.user.create({
            data: { id: `u-${Date.now()}`, email: `test-${Date.now()}@test.com`, name: 'Test User' }
        });
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("GITHUB_TOKEN is missing. Please set it in .env to run LIVE GITHUB E2E.");
    }
    const octokit = new Octokit({ auth: token });
    
    const { data } = await octokit.rest.repos.get({ owner: 'garg612', repo: 'demo1' });
    const testRepo = data;
    console.log("Using existing throwaway repo:", testRepo.full_name);

    // Ensure it's in DB
    const dbRepo = await prisma.repository.upsert({
        where: { githubId: BigInt(testRepo.id) },
        update: { userId: user.id },
        create: {
            githubId: BigInt(testRepo.id),
            name: testRepo.name,
            owner: testRepo.owner.login,
            fullName: testRepo.full_name,
            url: testRepo.html_url,
            userId: user.id
        }
    });

    // Create a new branch & PR
    const mainRef = await octokit.rest.git.getRef({
        owner: testRepo.owner.login,
        repo: testRepo.name,
        ref: 'heads/main'
    });

    const branchName = 'test-branch-' + Date.now();
    await octokit.rest.git.createRef({
        owner: testRepo.owner.login,
        repo: testRepo.name,
        ref: 'refs/heads/' + branchName,
        sha: mainRef.data.object.sha
    });

    // Create a file
    const content = Buffer.from('console.log("vulnerable");').toString('base64');
    const { data: fileResp } = await octokit.rest.repos.createOrUpdateFileContents({
        owner: testRepo.owner.login,
        repo: testRepo.name,
        path: 'test.js',
        message: 'Add test.js',
        content,
        branch: branchName
    });

    // Create PR
    const { data: pr } = await octokit.rest.pulls.create({
        owner: testRepo.owner.login,
        repo: testRepo.name,
        title: 'Test PR for Stage 7',
        head: branchName,
        base: 'main'
    });
    console.log("Created PR:", pr.html_url);

    const prHeadSha = pr.head.sha;

    // Simulated PRism discovering a finding and creating a fix
    const pullRequest = await prisma.pullRequest.create({
        data: {
            repositoryId: dbRepo.id,
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            authorLogin: pr.user?.login || 'test-user',
            headRef: pr.head.ref,
            headRepoFullName: testRepo.full_name,
            baseRef: pr.base.ref,
            latestHeadSha: prHeadSha,
        }
    });

    const reviewRun = await prisma.reviewRun.create({
        data: {
            repositoryId: dbRepo.id,
            pullRequestId: pullRequest.id,
            headSha: prHeadSha,
            baseSha: mainRef.data.object.sha,
            status: 'AWAITING_APPROVAL',
            trigger: 'OPENED',
            configSnapshot: {}
        }
    });

    const scanRun = await prisma.scanRun.create({
        data: {
            reviewRunId: reviewRun.id,
            kind: 'HEAD',
            source: 'SEMGREP',
            status: 'COMPLETED'
        }
    });

    const finding = await prisma.finding.create({
        data: {
            reviewRunId: reviewRun.id,
            scanRunId: scanRun.id,
            ruleId: 'test-rule',
            filePath: 'test.js',
            startLine: 1,
            endLine: 1,
            message: 'Vulnerable console.log',
            severity: 'HIGH',
            fingerprint: 'hash-' + Date.now(),
            source: 'SEMGREP',
            status: 'DETECTED'
        }
    });

    const fix = await prisma.suggestedFix.create({
        data: {
            reviewRunId: reviewRun.id,
            findingId: finding.id,
            status: 'READY',
            validatedHeadSha: prHeadSha,
            expiresAt: new Date(Date.now() + 1000000),
            edits: [
                {
                    path: 'test.js',
                    find: 'console.log("vulnerable");',
                    replace: 'console.log("safe");'
                }
            ]
        }
    });

    const patch = await prisma.patch.create({
        data: {
            suggestedFixId: fix.id,
            unifiedDiff: `--- a/test.js\n+++ b/test.js\n@@ -1,1 +1,1 @@\n-console.log("vulnerable");\n+console.log("safe");\n`,
            diffSha256: 'hash',
            filesChanged: 1,
            linesAdded: 1,
            linesRemoved: 1
        }
    });

    console.log("Simulated READY fix in DB. Now calling applyFixToGithub...");

    // Test STACKED_PR Delivery Mode
    const applyResult = await applyFixToGithub(octokit, 'FIX_BRANCH_PR', dbRepo, pullRequest, fix, patch);

    console.log("Apply Result:", applyResult);

    if (applyResult.success) {
        console.log("LIVE GITHUB E2E: PASS");
    } else {
        console.error("LIVE GITHUB E2E: FAIL", applyResult.error);
        throw new Error("LIVE GITHUB E2E: FAIL");
    }
}, 60000);
