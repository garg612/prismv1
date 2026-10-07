import { config } from 'dotenv';
config();
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { hashPassword } from 'better-auth/crypto';

let connectionString = process.env.DATABASE_URL || '';
connectionString = connectionString.replace('&channel_binding=require', '');
connectionString = connectionString.replace('?sslmode=verify-full', '?sslmode=require');

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const DEMO_USER_ID = "demo-user-1";

async function main() {
  console.log("Starting demo data seed...");

  // 1. Generate Repositories Data first so we know their IDs
  const repos = [
    { name: "prism-dashboard", desc: "PRism's web dashboard for AI-powered pull request reviews.", lang: "TypeScript" },
    { name: "commerce-api", desc: "Backend API for the PRism demo commerce platform.", lang: "TypeScript" },
    { name: "auth-service", desc: "Authentication and authorization service.", lang: "TypeScript" },
    { name: "notification-service", desc: "Notification and email processing service.", lang: "TypeScript" },
    { name: "analytics-engine", desc: "Analytics processing and reporting service.", lang: "Python" }
  ];

  const repoRecordsData = repos.map((r, i) => ({
    id: `repo-${i + 1}`,
    githubId: BigInt(100000 + i),
    name: r.name,
    owner: "prism-demo-org",
    fullName: `prism-demo-org/${r.name}`,
    url: `https://github.com/prism-demo-org/${r.name}`,
    description: r.desc,
    language: r.lang,
    createdAt: new Date(1700000000000 + i * 1000)
  }));

  const showcasePRs = [
    {
      repoId: repoRecordsData[0].id,
      prNumber: 142,
      prTitle: "fix: prevent duplicate webhook processing",
      status: "completed",
      daysAgo: 2,
      reviewText: `The pull request addresses the duplicate webhook issue but introduces some risks in error handling.\n\n### ⚠️ High\n**Webhook processing does not appear to be idempotent. Replayed webhook events could create duplicate processing records.**\n*Location: \`src/api/webhooks/github.ts\` line 142*\n*Status: OPEN*\n`
    },
    {
      repoId: repoRecordsData[1].id,
      prNumber: 138,
      prTitle: "feat: optimize repository indexing pipeline",
      status: "completed",
      daysAgo: 5,
      reviewText: `The indexing pipeline is much faster, but there are critical security and performance issues.\n\n### 🚨 Critical\n**Potential sensitive token exposure in error logging.**\n`
    },
    {
      repoId: repoRecordsData[2].id,
      prNumber: 135,
      prTitle: "refactor: simplify authentication middleware",
      status: "completed",
      daysAgo: 10,
      reviewText: `The implementation is clean and consistent with the existing architecture. No blocking issues were detected.\n\nLooks great! Safe to merge.`
    },
    {
      repoId: repoRecordsData[1].id,
      prNumber: 129,
      prTitle: "fix: handle failed payment webhook retries",
      status: "completed",
      daysAgo: 15,
      reviewText: `Good fix, but pay attention to the edge cases around timeouts.\n\n### ⚠️ High\n**Missing timeout for external payment gateway call.**\n*Location: \`src/services/payment.ts\` line 88*\n*Status: OPEN*\n`
    }
  ];

  const standardPRTitles = [
    "feat: add repository activity analytics",
    "fix: resolve dashboard loading state",
    "refactor: simplify repository service",
    "docs: update API integration guide",
    "test: improve authentication coverage",
    "fix: optimize repository synchronization",
    "feat: add bulk notification processing",
    "refactor: migrate repository queries",
    "fix: handle expired authentication tokens",
    "feat: add analytics aggregation",
    "chore: update dependencies",
    "fix: correct typo in settings UI",
    "feat: support dark mode toggle",
    "refactor: split large React components",
    "fix: memory leak in dashboard chart",
    "docs: clarify webhook payload structure",
    "test: add e2e tests for login flow",
    "feat: introduce rate limiting middleware",
    "fix: handle null response from GitHub API",
    "chore: clean up unused variables",
    "feat: user avatar upload"
  ];

  const allReviews = [...showcasePRs];
  for (let i = 0; i < standardPRTitles.length; i++) {
    const title = standardPRTitles[i];
    const repoRecord = repoRecordsData[i % repoRecordsData.length];
    const daysAgo = (i * 2) % 45 + 1; // Deterministic instead of Math.random
    let reviewText = "The pull request is generally well structured.";
    if (title.startsWith("feat")) {
        reviewText += "\n\n### 🟡 Medium\n**Consider adding unit tests for this new feature.**\n*Status: OPEN*";
    } else if (title.startsWith("fix")) {
        reviewText += "\n\n### 🟢 Low\n**Ensure this fix is covered by regression tests.**\n*Status: FIXED*";
    } else if (title.startsWith("refactor")) {
        reviewText += "\n\nNo significant issues found. The refactor improves maintainability.";
    }

    allReviews.push({
      repoId: repoRecord.id,
      prNumber: 100 + i,
      prTitle: title,
      status: (i % 5 === 0) ? "failed" : "completed", // Deterministic
      daysAgo: daysAgo,
      reviewText: reviewText
    });
  }

  const reviewsCounts: Record<string, number> = {};
  for (const r of allReviews) {
      reviewsCounts[r.repoId] = (reviewsCounts[r.repoId] || 0) + 1;
  }

  console.log("Upserting demo user...");
  const user = await prisma.user.upsert({
    where: { email: "demo@prism.local" },
    update: {},
    create: {
      id: DEMO_USER_ID,
      name: "Aarav Sharma",
      email: "demo@prism.local",
      emailVerified: true,
      subscriptionTier: "PRO",
      subscriptionStatus: "ACTIVE",
      polarCustomerId: "mock_polar_cus_123",
      polarSubscriptionId: "mock_polar_sub_123",
      usage: {
        create: {
          repositoriesCount: repoRecordsData.length,
          reviewsCounts: reviewsCounts
        }
      }
    },
  });

  const hashedPassword = await hashPassword("Demo@123");
  await prisma.account.upsert({
    where: { id: `account-${DEMO_USER_ID}` },
    update: { password: hashedPassword },
    create: {
      id: `account-${DEMO_USER_ID}`,
      accountId: DEMO_USER_ID,
      providerId: "credential",
      userId: DEMO_USER_ID,
      password: hashedPassword,
      accessToken: "demo_token"
    }
  });

  console.log("Upserting repositories...");
  const repoRecords: any[] = [];
  for (const r of repoRecordsData) {
    const repoRecord = await prisma.repository.upsert({
      where: { githubId: r.githubId },
      update: { description: r.description, language: r.language },
      create: {
        id: r.id,
        githubId: r.githubId,
        name: r.name,
        owner: r.owner,
        fullName: r.fullName,
        url: r.url,
        userId: user.id,
        description: r.description,
        language: r.language,
        createdAt: r.createdAt,
      }
    });
    repoRecords.push(repoRecord);
  }

  console.log("Upserting reviews...");
  await prisma.review.deleteMany({
    where: { repository: { userId: DEMO_USER_ID } }
  });

  for (let i = 0; i < allReviews.length; i++) {
    const r = allReviews[i];
    const createdAt = new Date(1700000000000 - r.daysAgo * 24 * 60 * 60 * 1000);
    const prUrl = `https://github.com/prism-demo-org/${repoRecordsData.find(re => re.id === r.repoId)?.name}/pull/${r.prNumber}`;
    await prisma.review.create({
      data: {
        id: `mock-review-${i}`,
        repositoryId: r.repoId,
        prNumber: r.prNumber,
        prTitle: r.prTitle,
        status: r.status,
        prUrl: prUrl,
        review: r.reviewText,
        headSha: "mock-sha-1234567890",
        createdAt: createdAt,
        updatedAt: createdAt
      }
    });
  }

  console.log("Creating Stage 1 Pipeline Demo Data...");
  
  // Cleanup Stage 1 demo data specifically using cascading deletes via ReviewRun
  await prisma.reviewRun.deleteMany({
    where: { pullRequest: { repository: { userId: DEMO_USER_ID } } }
  });
  await prisma.pullRequest.deleteMany({
    where: { repository: { userId: DEMO_USER_ID } }
  });

  const demoRepo = repoRecordsData[0];
  const headSha = "a1b2c3d4e5f6g7h8i9j0";
  
  const pullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId: demoRepo.id,
      number: 999,
      title: "feat: full pipeline demo",
      url: `https://github.com/${demoRepo.fullName}/pull/999`,
      authorLogin: "demo-author",
      headRef: "feature-branch",
      headRepoFullName: demoRepo.fullName,
      baseRef: "main",
      latestHeadSha: headSha,
    }
  });

  const reviewRun = await prisma.reviewRun.create({
    data: {
      pullRequestId: pullRequest.id,
      repositoryId: demoRepo.id,
      headSha: headSha,
      trigger: "OPENED",
      status: "COMPLETED",
      configSnapshot: { semgrepVersion: "1.0", modelVersion: "v2" },
      totalFindings: 2,
      surfacedCount: 1,
      suppressedCount: 1,
      fixesGenerated: 2,
      fixesReady: 1,
      fixesFailed: 1
    }
  });

  const scanRun = await prisma.scanRun.create({
    data: {
      reviewRunId: reviewRun.id,
      kind: "HEAD",
      source: "SEMGREP",
      status: "COMPLETED"
    }
  });

  // 1 surfaced finding
  const surfacedFinding = await prisma.finding.create({
    data: {
      reviewRunId: reviewRun.id,
      scanRunId: scanRun.id,
      source: "SEMGREP",
      ruleId: "js.security.eval",
      severity: "HIGH",
      message: "Avoid eval()",
      filePath: "src/utils.js",
      startLine: 10,
      endLine: 10,
      fingerprint: "fp-eval-123",
      status: "SURFACED",
      classifications: {
        create: {
          modelName: "classifier-v1",
          modelVersion: "1.0",
          score: 0.9,
          modelDecision: "SURFACE",
          finalDecision: "SURFACE",
          decisionSource: "MODEL"
        }
      }
    }
  });

  // 1 suppressed finding
  const suppressedFinding = await prisma.finding.create({
    data: {
      reviewRunId: reviewRun.id,
      scanRunId: scanRun.id,
      source: "SEMGREP",
      ruleId: "js.style.indent",
      severity: "INFO",
      message: "Bad indentation",
      filePath: "src/utils.js",
      startLine: 15,
      endLine: 15,
      fingerprint: "fp-indent-123",
      status: "SUPPRESSED",
      classifications: {
        create: {
          modelName: "classifier-v1",
          modelVersion: "1.0",
          score: 0.1,
          modelDecision: "SUPPRESS",
          finalDecision: "SUPPRESS",
          decisionSource: "MODEL"
        }
      }
    }
  });

  // 1 ready fix
  const readyFix = await prisma.suggestedFix.create({
    data: {
      findingId: surfacedFinding.id,
      reviewRunId: reviewRun.id,
      status: "READY",
      outcome: "FIXED",
      edits: { diff: "- eval(x)\n+ JSON.parse(x)" },
      patch: {
        create: {
          unifiedDiff: "@@ -10,1 +10,1 @@\n- eval(x)\n+ JSON.parse(x)",
          diffSha256: "dummy-sha256",
          filesChanged: 1,
          linesAdded: 1,
          linesRemoved: 1
        }
      }
    }
  });

  // 1 failed/not-ready fix
  await prisma.suggestedFix.create({
    data: {
      findingId: suppressedFinding.id,
      reviewRunId: reviewRun.id,
      status: "IMPLEMENT_FAILED",
      edits: {}
    }
  });

  // 1 validation result
  const validationRun = await prisma.validationRun.create({
    data: {
      reviewRunId: reviewRun.id,
      suggestedFixId: readyFix.id,
      kind: "FIXED",
      tier: "STATIC",
      status: "COMPLETED",
      headSha: headSha
    }
  });

  await prisma.validationResult.create({
    data: {
      validationRunId: validationRun.id,
      check: "SYNTAX",
      status: "PASSED"
    }
  });

  console.log("✅ Demo data seeded successfully.");
  console.log("-----------------------------------------");
  console.log("Login Email: demo@prism.local");
  console.log("Login Password: Demo@123");
  console.log("-----------------------------------------");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
