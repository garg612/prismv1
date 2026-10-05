-- CreateEnum
CREATE TYPE "FindingSource" AS ENUM ('SEMGREP', 'ESLINT', 'BANDIT', 'SONAR', 'DEPENDENCY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('SECURITY', 'CORRECTNESS', 'PERFORMANCE', 'MAINTAINABILITY', 'STYLE', 'BEST_PRACTICE', 'OTHER');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('DETECTED', 'SUPPRESSED', 'SURFACED', 'NO_AUTOFIX', 'FIX_IN_PROGRESS', 'FIX_READY', 'FIX_FAILED', 'ACCEPTED', 'REJECTED', 'STALE');

-- CreateEnum
CREATE TYPE "TriageDecision" AS ENUM ('SURFACE', 'SUPPRESS');

-- CreateEnum
CREATE TYPE "DecisionSource" AS ENUM ('MODEL', 'POLICY_FALLBACK', 'POLICY_SEVERITY_FLOOR', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'SCANNING', 'CLASSIFYING', 'FIXING', 'VALIDATING', 'REPORTING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELED', 'SUPERSEDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('OPENED', 'SYNCHRONIZE', 'REOPENED', 'READY_FOR_REVIEW', 'MANUAL_RERUN', 'POST_APPLY_VERIFY');

-- CreateEnum
CREATE TYPE "ScanKind" AS ENUM ('HEAD', 'BASE', 'POST_FIX');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELED');

-- CreateEnum
CREATE TYPE "FixStatus" AS ENUM ('PENDING', 'GENERATING', 'GENERATED', 'GUARD_REJECTED', 'VALIDATING', 'READY', 'NOT_READY', 'IMPLEMENTING', 'IMPLEMENTED', 'IMPLEMENT_FAILED', 'REJECTED', 'STALE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FixOutcome" AS ENUM ('FIXED', 'PARTIALLY_FIXED', 'NOT_FIXED', 'NEW_FINDING_INTRODUCED', 'VALIDATION_FAILED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "ValidationKind" AS ENUM ('BASELINE', 'FIXED', 'COMBINED');

-- CreateEnum
CREATE TYPE "ValidationTier" AS ENUM ('STATIC', 'EXECUTION');

-- CreateEnum
CREATE TYPE "CheckName" AS ENUM ('PATCH_APPLY', 'SYNTAX', 'SEMGREP_RESCAN', 'INSTALL', 'LINT', 'BUILD', 'TEST');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'UNAVAILABLE', 'TIMEOUT', 'ERROR');

-- CreateEnum
CREATE TYPE "FindingDelta" AS ENUM ('REMOVED', 'UNCHANGED', 'ADDED');

-- CreateEnum
CREATE TYPE "FeedbackKind" AS ENUM ('FIX_ACCEPTED', 'FIX_REJECTED', 'FALSE_POSITIVE', 'TRUE_POSITIVE', 'DISMISSED', 'UNSUPPRESS_REQUEST');

-- CreateEnum
CREATE TYPE "ApplyMode" AS ENUM ('DIRECT_COMMIT', 'FIX_BRANCH_PR', 'SUGGESTION_COMMENT');

-- CreateEnum
CREATE TYPE "ApplyStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REJECTED_STALE');

-- AlterTable
ALTER TABLE "repository" ADD COLUMN     "defaultBranch" TEXT,
ADD COLUMN     "executionValidation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fixDeliveryMode" TEXT,
ADD COLUMN     "holisticReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "indexState" TEXT,
ADD COLUMN     "indexedSha" TEXT,
ADD COLUMN     "webhookId" TEXT,
ADD COLUMN     "webhookSecretVersion" INTEGER;

-- AlterTable
ALTER TABLE "review" ADD COLUMN     "reportJson" JSONB,
ADD COLUMN     "reportSchemaVersion" INTEGER,
ADD COLUMN     "reviewRunId" TEXT;

ALTER TABLE "webhookEvent" ADD COLUMN     "action" TEXT,
ADD COLUMN     "deliveryId" TEXT,
ADD COLUMN     "payloadHash" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "repoGithubId" BIGINT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'processed';

UPDATE "webhookEvent" SET "deliveryId" = "id", "id" = gen_random_uuid()::text;
ALTER TABLE "webhookEvent" ALTER COLUMN "deliveryId" SET NOT NULL;

-- CreateTable
CREATE TABLE "pullRequest" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authorLogin" TEXT NOT NULL,
    "headRef" TEXT NOT NULL,
    "headRepoFullName" TEXT NOT NULL,
    "baseRef" TEXT NOT NULL,
    "isFork" BOOLEAN NOT NULL DEFAULT false,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'open',
    "latestHeadSha" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviewRun" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "trigger" "RunTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL,
    "failureStage" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "supersededById" TEXT,
    "inngestRunId" TEXT,
    "configSnapshot" JSONB NOT NULL,
    "totalFindings" INTEGER NOT NULL DEFAULT 0,
    "surfacedCount" INTEGER NOT NULL DEFAULT 0,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "fixesGenerated" INTEGER NOT NULL DEFAULT 0,
    "fixesReady" INTEGER NOT NULL DEFAULT 0,
    "fixesFailed" INTEGER NOT NULL DEFAULT 0,
    "billedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanRun" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "suggestedFixId" TEXT,
    "kind" "ScanKind" NOT NULL,
    "source" "FindingSource" NOT NULL,
    "toolVersion" TEXT,
    "rulesetId" TEXT,
    "status" "JobStatus" NOT NULL,
    "runnerJobId" TEXT,
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "scannedFiles" INTEGER,
    "skippedFiles" INTEGER,
    "toolErrors" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "scanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "scanRunId" TEXT NOT NULL,
    "source" "FindingSource" NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT,
    "category" "FindingCategory" NOT NULL DEFAULT 'OTHER',
    "severity" "Severity" NOT NULL,
    "sourceSeverity" TEXT,
    "confidence" "Confidence" NOT NULL DEFAULT 'UNKNOWN',
    "message" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "startCol" INTEGER,
    "endCol" INTEGER,
    "language" TEXT,
    "codeSnippet" TEXT,
    "fingerprint" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "inChangedLines" BOOLEAN NOT NULL DEFAULT false,
    "isPreexisting" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "status" "FindingStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findingClassification" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "policyVersion" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "modelDecision" "TriageDecision" NOT NULL,
    "uncertain" BOOLEAN NOT NULL DEFAULT false,
    "finalDecision" "TriageDecision" NOT NULL,
    "decisionSource" "DecisionSource" NOT NULL,
    "thresholdHigh" DOUBLE PRECISION,
    "thresholdLow" DOUBLE PRECISION,
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reasonText" TEXT,
    "isShadow" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "requestId" TEXT,
    "featureSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "findingClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findingFeedback" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "suggestedFixId" TEXT,
    "userId" TEXT NOT NULL,
    "kind" "FeedbackKind" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "findingFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggestedFix" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "FixStatus" NOT NULL,
    "outcome" "FixOutcome",
    "validatedHeadSha" TEXT,
    "llmModel" TEXT,
    "promptVersion" TEXT,
    "explanation" TEXT,
    "reasoningSummary" TEXT,
    "selfConfidence" DOUBLE PRECISION,
    "edits" JSONB NOT NULL,
    "contextRefs" JSONB,
    "llmUsage" JSONB,
    "readyAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suggestedFix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patch" (
    "id" TEXT NOT NULL,
    "suggestedFixId" TEXT NOT NULL,
    "unifiedDiff" TEXT NOT NULL,
    "diffSha256" TEXT NOT NULL,
    "filesChanged" INTEGER NOT NULL,
    "linesAdded" INTEGER NOT NULL,
    "linesRemoved" INTEGER NOT NULL,
    "baseBlobShas" JSONB,
    "guardReport" JSONB,

    CONSTRAINT "patch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validationRun" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "suggestedFixId" TEXT,
    "kind" "ValidationKind" NOT NULL,
    "tier" "ValidationTier" NOT NULL,
    "status" "JobStatus" NOT NULL,
    "headSha" TEXT NOT NULL,
    "sandboxProvider" TEXT,
    "imageDigest" TEXT,
    "limits" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "validationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validationResult" (
    "id" TEXT NOT NULL,
    "validationRunId" TEXT NOT NULL,
    "check" "CheckName" NOT NULL,
    "status" "CheckStatus" NOT NULL,
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "summary" TEXT,
    "logExcerpt" TEXT,

    CONSTRAINT "validationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validationFinding" (
    "id" TEXT NOT NULL,
    "validationRunId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "severity" "Severity" NOT NULL,
    "delta" "FindingDelta" NOT NULL,

    CONSTRAINT "validationFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applyAttempt" (
    "id" TEXT NOT NULL,
    "suggestedFixId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "ApplyMode" NOT NULL,
    "status" "ApplyStatus" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "expectedHeadSha" TEXT NOT NULL,
    "observedHeadSha" TEXT,
    "resultCommitSha" TEXT,
    "resultBranch" TEXT,
    "resultPrUrl" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applyAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pullRequest_repositoryId_number_key" ON "pullRequest"("repositoryId", "number");

-- CreateIndex
CREATE INDEX "reviewRun_repositoryId_status_idx" ON "reviewRun"("repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reviewRun_pullRequestId_headSha_attempt_key" ON "reviewRun"("pullRequestId", "headSha", "attempt");

-- CreateIndex
CREATE INDEX "finding_reviewRunId_status_idx" ON "finding"("reviewRunId", "status");

-- CreateIndex
CREATE INDEX "finding_fingerprint_idx" ON "finding"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "finding_reviewRunId_source_fingerprint_occurrence_key" ON "finding"("reviewRunId", "source", "fingerprint", "occurrence");

-- CreateIndex
CREATE UNIQUE INDEX "patch_suggestedFixId_key" ON "patch"("suggestedFixId");

-- CreateIndex
CREATE UNIQUE INDEX "validationResult_validationRunId_check_key" ON "validationResult"("validationRunId", "check");

-- CreateIndex
CREATE UNIQUE INDEX "applyAttempt_idempotencyKey_key" ON "applyAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "repository_owner_name_key" ON "repository"("owner", "name");

-- CreateIndex
CREATE UNIQUE INDEX "review_reviewRunId_key" ON "review"("reviewRunId");

-- CreateIndex
CREATE UNIQUE INDEX "webhookEvent_deliveryId_key" ON "webhookEvent"("deliveryId");

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "reviewRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pullRequest" ADD CONSTRAINT "pullRequest_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviewRun" ADD CONSTRAINT "reviewRun_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviewRun" ADD CONSTRAINT "reviewRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanRun" ADD CONSTRAINT "scanRun_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "reviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "reviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "scanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findingClassification" ADD CONSTRAINT "findingClassification_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findingFeedback" ADD CONSTRAINT "findingFeedback_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findingFeedback" ADD CONSTRAINT "findingFeedback_suggestedFixId_fkey" FOREIGN KEY ("suggestedFixId") REFERENCES "suggestedFix"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findingFeedback" ADD CONSTRAINT "findingFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestedFix" ADD CONSTRAINT "suggestedFix_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patch" ADD CONSTRAINT "patch_suggestedFixId_fkey" FOREIGN KEY ("suggestedFixId") REFERENCES "suggestedFix"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validationRun" ADD CONSTRAINT "validationRun_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "reviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validationRun" ADD CONSTRAINT "validationRun_suggestedFixId_fkey" FOREIGN KEY ("suggestedFixId") REFERENCES "suggestedFix"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validationResult" ADD CONSTRAINT "validationResult_validationRunId_fkey" FOREIGN KEY ("validationRunId") REFERENCES "validationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validationFinding" ADD CONSTRAINT "validationFinding_validationRunId_fkey" FOREIGN KEY ("validationRunId") REFERENCES "validationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applyAttempt" ADD CONSTRAINT "applyAttempt_suggestedFixId_fkey" FOREIGN KEY ("suggestedFixId") REFERENCES "suggestedFix"("id") ON DELETE CASCADE ON UPDATE CASCADE;
