import 'dotenv/config';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../src/lib/db';
import { acceptFix, rejectFix, acceptReadyFixes } from '../../src/modules/review/actions/fixes';
import * as github from '../../src/modules/github/lib/github';
import * as auth from '../../src/lib/auth';

// Mock dependencies
vi.mock('../../src/lib/auth', () => ({
    auth: {
        api: {
            getSession: vi.fn(),
        }
    }
}));

vi.mock('../../src/modules/github/lib/github', () => ({
    getGithubToken: vi.fn().mockResolvedValue('fake-token'),
}));

vi.mock('next/headers', () => ({
    headers: vi.fn().mockResolvedValue(new Map())
}));

vi.mock('../../src/inngest/client', () => ({
    inngest: { send: vi.fn() }
}));

// We'll also mock octokit for specific error scenarios
vi.mock('octokit', () => {
    const mockRest = {
        pulls: {
            get: vi.fn(),
            create: vi.fn(),
            createReview: vi.fn(),
        },
        git: {
            getRef: vi.fn(),
            createRef: vi.fn(),
            createTree: vi.fn(),
            createCommit: vi.fn(),
            updateRef: vi.fn(),
        },
        repos: {
            getContent: vi.fn(),
        }
    };
    return {
        Octokit: class {
            rest = mockRest;
        }
    };
});

// DANGER: this suite's afterEach runs unfiltered deleteMany() on user, repository,
// pullRequest, reviewRun, finding and more, against whatever DATABASE_URL points to.
// It must only ever run against a throwaway database, so it is opt-in.
const destructiveDbTestsAllowed = process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

describe.skipIf(!destructiveDbTestsAllowed)('Stage 7: Approval UI + Safe GitHub Fix Application (CONTROLLED INTEGRATION)', () => {
    let user: any;
    let repo: any;
    let reviewRun: any;
    let finding: any;
    let fix: any;
    let pr: any;

    beforeEach(async () => {
        user = await prisma.user.create({
            data: { id: `u-${Date.now()}`, email: `test-${Date.now()}@test.com`, name: 'Test User' }
        });

        repo = await prisma.repository.create({
            data: {
                githubId: BigInt(Date.now()),
                owner: 'testowner',
                name: 'testrepo',
                fullName: 'testowner/testrepo',
                url: 'https://github.com/testowner/testrepo',
                userId: user.id
            }
        });

        pr = await prisma.pullRequest.create({
            data: {
                repositoryId: repo.id,
                number: 1,
                authorLogin: 'testauthor',
                title: 'Test PR',
                url: 'https://github.com/testowner/testrepo/pull/1',
                headRef: 'test-branch',
                headRepoFullName: 'testowner/testrepo',
                baseRef: 'main',
                latestHeadSha: 'old-sha'
            }
        });

        reviewRun = await prisma.reviewRun.create({
            data: {
                repositoryId: repo.id,
                pullRequestId: pr.id,
                headSha: 'sha-a',
                baseSha: 'sha-base',
                status: 'AWAITING_APPROVAL',
                trigger: 'OPENED',
                configSnapshot: {}
            }
        });

        await prisma.review.create({
            data: {
                reviewRunId: reviewRun.id,
                repositoryId: repo.id,
                status: 'COMPLETED',
                reportJson: { some: 'data' },
                prNumber: 1,
                prTitle: 'Test PR',
                prUrl: 'https://github.com/testowner/testrepo/pull/1',
                review: 'Test review content'
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

        finding = await prisma.finding.create({
            data: {
                reviewRunId: reviewRun.id,
                scanRunId: scanRun.id,
                ruleId: 'test-rule',
                filePath: 'index.js',
                startLine: 1,
                endLine: 1,
                message: 'Test finding',
                severity: 'HIGH',
                fingerprint: 'fingerprint-1',
                source: 'SEMGREP',
                status: 'DETECTED'
            }
        });

        fix = await prisma.suggestedFix.create({
            data: {
                reviewRunId: reviewRun.id,
                findingId: finding.id,
                status: 'READY',
                validatedHeadSha: 'sha-a',
                expiresAt: new Date(Date.now() + 100000),
                edits: {}
            }
        });

        const patch = await prisma.patch.create({
            data: {
                suggestedFixId: fix.id,
                unifiedDiff: 'fake-diff',
                diffSha256: 'hash',
                filesChanged: 1,
                linesAdded: 1,
                linesRemoved: 1
            }
        });

        // Setup default auth mock
        (auth.auth.api.getSession as any).mockResolvedValue({
            user: { id: user.id }
        });
    });

    afterEach(async () => {
        vi.clearAllMocks();
        // Clean up DB
        await prisma.applyAttempt.deleteMany();
        await prisma.findingFeedback.deleteMany();
        await prisma.suggestedFix.deleteMany();
        await prisma.patch.deleteMany();
        await prisma.finding.deleteMany();
        await prisma.review.deleteMany();
        await prisma.reviewRun.deleteMany();
        await prisma.pullRequest.deleteMany();
        await prisma.repository.deleteMany();
        await prisma.user.deleteMany();
    });

    it('SERVER AUTHORIZATION: blocks unauthenticated requests', async () => {
        (auth.auth.api.getSession as any).mockResolvedValue(null);
        const res = await acceptFix(fix.id);
        expect(res).toEqual({ success: false, error: 'UNAUTHORIZED' });
    });

    it('SERVER AUTHORIZATION: blocks unauthorized user (wrong repo owner)', async () => {
        (auth.auth.api.getSession as any).mockResolvedValue({ user: { id: 'wrong-id' } });
        const res = await acceptFix(fix.id);
        expect(res).toEqual({ success: false, error: 'FORBIDDEN' });
    });

    it('SERVER AUTHORIZATION: blocks non-AWAITING_APPROVAL run', async () => {
        await prisma.reviewRun.update({ where: { id: reviewRun.id }, data: { status: 'COMPLETED' } });
        const res = await acceptFix(fix.id);
        expect(res).toEqual({ success: false, error: 'INVALID_REVIEW_STATE' });
    });

    it('SERVER AUTHORIZATION: blocks non-READY fix', async () => {
        await prisma.suggestedFix.update({ where: { id: fix.id }, data: { status: 'IMPLEMENTING' } });
        const res = await acceptFix(fix.id);
        expect(res).toEqual({ success: false, error: 'FIX_NOT_READY' });
    });

    it('EXPIRY: blocks expired fixes and transitions to EXPIRED', async () => {
        await prisma.suggestedFix.update({ where: { id: fix.id }, data: { expiresAt: new Date(Date.now() - 10000) } });
        const res = await acceptFix(fix.id);
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/expired/i);
        const updatedFix = await prisma.suggestedFix.findUnique({ where: { id: fix.id } });
        expect(updatedFix?.status).toBe('EXPIRED');
    });

    it('STALE SHA RACE: safely detects out of date head SHA', async () => {
        const { Octokit } = await import('octokit');
        const octokitInstance = new Octokit();
        (octokitInstance.rest.pulls.get as any).mockResolvedValue({
            data: { head: { sha: 'sha-b' }, state: 'open' }
        });

        const res = await acceptFix(fix.id);
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/out of date/i);

        const attempt = await prisma.applyAttempt.findFirst({ where: { suggestedFixId: fix.id } });
        expect(attempt?.status).toBe('REJECTED_STALE');
        expect(attempt?.expectedHeadSha).toBe('sha-a');
        expect(attempt?.observedHeadSha).toBe('sha-b');
        
        const updatedFix = await prisma.suggestedFix.findUnique({ where: { id: fix.id } });
        expect(updatedFix?.status).toBe('STALE');
    });

    it('DOUBLE CLICK / CONCURRENT ACCEPT: allows exactly one application', async () => {
        const { Octokit } = await import('octokit');
        const octokitInstance = new Octokit();
        (octokitInstance.rest.pulls.get as any).mockResolvedValue({
            data: { head: { sha: 'sha-a' }, state: 'open' }
        });

        // Mock applyFixToGithub success
        const applyFixModule = await import('../../src/modules/github/lib/apply-fix');
        vi.spyOn(applyFixModule, 'applyFixToGithub').mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 100));
            return { success: true, resultCommitSha: 'sha-c', resultBranch: 'prism/fix/test', resultPrUrl: 'http://pr' };
        });

        // Fire both concurrently
        const [res1, res2] = await Promise.all([
            acceptFix(fix.id),
            acceptFix(fix.id)
        ]);

        // One should succeed, one should fail due to FIX_ALREADY_PROCESSING
        const successes = [res1.success, res2.success];
        expect(successes.filter(s => s)).toHaveLength(1);
        expect(successes.filter(s => !s)).toHaveLength(1);

        const attempts = await prisma.applyAttempt.findMany({ where: { suggestedFixId: fix.id } });
        expect(attempts).toHaveLength(1);
        expect(attempts[0].status).toBe('SUCCEEDED');
    });

    it('REJECT FLOW: marks finding and fix as REJECTED', async () => {
        const res = await rejectFix(fix.id);
        expect(res.success).toBe(true);

        const updatedFix = await prisma.suggestedFix.findUnique({ where: { id: fix.id } });
        expect(updatedFix?.status).toBe('REJECTED');

        const fb = await prisma.findingFeedback.findFirst({ where: { findingId: finding.id } });
        expect(fb?.kind).toBe('FIX_REJECTED');
    });

    it('ACCEPT READY FIXES: safely gates combined application', async () => {
        const res = await acceptReadyFixes(reviewRun.id);
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/Combined validation triggered/i);
    });

    it('EXPIRED/CLOSED PR: blocks apply if PR is closed', async () => {
        const { Octokit } = await import('octokit');
        const octokitInstance = new Octokit();
        (octokitInstance.rest.pulls.get as any).mockResolvedValue({
            data: { head: { sha: 'sha-a' }, state: 'closed' }
        });

        const githubModule = await import('../../src/modules/github/lib/apply-fix');
        vi.spyOn(githubModule, 'applyFixToGithub').mockResolvedValue({
            success: false, error: 'PR is not open'
        });

        const res = await acceptFix(fix.id);
        expect(res.success).toBe(false);
        const attempt = await prisma.applyAttempt.findFirst({ where: { suggestedFixId: fix.id } });
        expect(attempt?.status).toBe('FAILED');
    });
});
