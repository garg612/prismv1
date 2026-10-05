import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRepositories } from '../../src/modules/github/lib/github';
import { getContributionStats, getDashboardStats, getMonthlyActivity } from '../../src/modules/dashboard/actions';
import { getReview } from '../../src/modules/review/actions';
import { auth } from '../../src/lib/auth';
import prisma from '../../src/lib/db';

vi.mock('../../src/lib/auth', () => ({
    auth: {
        api: {
            getSession: vi.fn()
        }
    }
}));

vi.mock('next/headers', () => ({
    headers: vi.fn()
}));

// Mock Prisma
vi.mock('../../src/lib/db', () => ({
    default: {
        account: {
            findFirst: vi.fn()
        },
        repository: {
            findMany: vi.fn(),
            count: vi.fn()
        },
        review: {
            findMany: vi.fn(),
            count: vi.fn()
        }
    }
}));

// Mock octokit
vi.mock('octokit', () => {
    return {
        Octokit: class {
            rest = {
                users: {
                    getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'real_github_user' } })
                },
                repos: {
                    listForAuthenticatedUser: vi.fn().mockResolvedValue({
                        data: [
                            { id: 101, name: 'repo-a' },
                            { id: 102, name: 'repo-b' },
                            { id: 103, name: 'repo-c' }
                        ]
                    })
                },
                search: {
                    issuesAndPullRequests: vi.fn().mockResolvedValue({
                        data: {
                            total_count: 5,
                            items: []
                        }
                    })
                }
            };
            graphql = vi.fn().mockResolvedValue({
                user: {
                    contributionsCollection: {
                        contributionCalendar: {
                            totalContributions: 10,
                            weeks: []
                        }
                    }
                }
            });
        }
    }
});

describe('Real Mode vs Demo Mode Isolation', () => {
    const originalEnv = process.env.NEXT_PUBLIC_DEMO_MODE;

    afterEach(() => {
        process.env.NEXT_PUBLIC_DEMO_MODE = originalEnv;
        vi.clearAllMocks();
    });

    it('13. REAL LOGIN TEST: should fetch real repositories and not demo ones', async () => {
        process.env.NEXT_PUBLIC_DEMO_MODE = 'false';
        
        (auth.api.getSession as any).mockResolvedValue({
            user: { id: 'test-real-user' }
        });

        // Mock getting access token from account table
        (prisma.account.findFirst as any).mockResolvedValue({
            accessToken: 'real-access-token'
        });

        const repos = await getRepositories(1, 10);
        
        // Assert it did not query DB for repositories (which demo mode does)
        expect(prisma.repository.findMany).not.toHaveBeenCalled();

        expect(repos).toHaveLength(3);
        expect(repos[0].name).toBe('repo-a');
        expect(repos[1].name).toBe('repo-b');
        expect(repos[2].name).toBe('repo-c');
    });

    it('14. DEMO LOGIN TEST: should fetch demo repositories', async () => {
        process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
        
        // Mock DB repos for demo mode
        (prisma.repository.findMany as any).mockResolvedValue([
            { id: 1, githubId: '1001', name: 'demo-repo', fullName: 'demo/demo-repo', description: '', url: 'http' }
        ]);

        const repos = await getRepositories(1, 10);
        
        // Assert it DID query DB for repositories
        expect(prisma.repository.findMany).toHaveBeenCalled();
        
        expect(repos).toBeDefined();
        expect(Array.isArray(repos)).toBe(true);
        expect(repos[0].name).toBe('demo-repo');
    });

    it('15. CROSS-USER ISOLATION TEST & 16. REVIEW DATA ISOLATION', async () => {
        process.env.NEXT_PUBLIC_DEMO_MODE = 'false';

        const reviewA = { id: 'rev-a', repositoryId: 'repo-a' };
        const reviewB = { id: 'rev-b', repositoryId: 'repo-b' };

        // Test User A
        (auth.api.getSession as any).mockResolvedValue({ user: { id: 'user-a' } });
        
        // When prisma searches for reviews, make sure it receives query args
        (prisma.review.findMany as any).mockImplementation(async (args: any) => {
            if (args?.where?.repository?.userId === 'user-a') return [reviewA];
            if (args?.where?.repository?.userId === 'user-b') return [reviewB];
            return [];
        });

        let reviews = await getReview();
        expect(reviews.length).toBe(1);
        expect(reviews[0].id).toBe(reviewA.id);
        
        // Expect prisma.review.findMany was called with proper user filtering
        expect(prisma.review.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                repository: expect.objectContaining({
                    userId: 'user-a'
                })
            })
        }));

        // Test User B
        (auth.api.getSession as any).mockResolvedValue({ user: { id: 'user-b' } });
        reviews = await getReview();
        expect(reviews.length).toBe(1);
        expect(reviews[0].id).toBe(reviewB.id);

        expect(prisma.review.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                repository: expect.objectContaining({
                    userId: 'user-b'
                })
            })
        }));
    });
});
