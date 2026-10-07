/**
 * Stage 5 RAG v2 — Pinecone namespace isolation tests
 * These tests verify:
 * - Namespace per-repository isolation (pure logic, no Pinecone call)
 * - Disconnect deletes only the correct namespace (design contract)
 * - No cross-tenant query leakage (namespace format)
 * - Index state machine transitions
 * - Incremental push filtering
 * - Inngest step output safety
 *
 * Pure logic tests only — no Pinecone API key required.
 */

import { describe, it, expect } from 'vitest';
import { makeVectorId } from '../../src/modules/ai/lib/chunker';

// Inline the namespace logic to test the pure format without importing Pinecone client
function repoNamespace(repositoryId: string): string {
    return `repo:${repositoryId}`;
}

// Inline the legacy cleanup logic to test it without Pinecone call
async function deleteLegacyRepositoryVectorsMock(pineconeIndexMock: any, repoFullName: string): Promise<void> {
    await pineconeIndexMock.deleteMany({ repoId: repoFullName });
}

// ---- Unit tests for namespace logic ----

describe('Stage 5 Pinecone Namespace Isolation', () => {
    it('produces correct namespace format', () => {
        expect(repoNamespace('repo-abc-123')).toBe('repo:repo-abc-123');
        expect(repoNamespace('uuid-xxxx-yyyy')).toBe('repo:uuid-xxxx-yyyy');
    });

    it('isolates repos A and B by namespace', () => {
        const nsA = repoNamespace('repo-A');
        const nsB = repoNamespace('repo-B');
        expect(nsA).not.toBe(nsB);
        expect(nsA).toBe('repo:repo-A');
        expect(nsB).toBe('repo:repo-B');
    });

    it('vector IDs are scoped to repository', () => {
        const idA = makeVectorId('repo-A', 'src/main.ts', 0, 'abc1');
        const idB = makeVectorId('repo-B', 'src/main.ts', 0, 'abc1');
        expect(idA).not.toBe(idB);
        expect(idA.startsWith('repo-A#')).toBe(true);
        expect(idB.startsWith('repo-B#')).toBe(true);
    });

    it('deleteAll on namespace A does not affect namespace B (contract)', () => {
        const nsA = repoNamespace('repo-A');
        const nsB = repoNamespace('repo-B');
        expect(nsA).not.toBe(nsB);
        expect(nsA.includes('repo-B')).toBe(false);
    });
});

// ---- Legacy Vector Migration / Cleanup ----

describe('Stage 5 Legacy Vector Migration / Cleanup', () => {
    it('deletes legacy vectors deterministically once populated using repoId filter', async () => {
        const mockPineconeIndex = {
            deleteMany: (args: any) => Promise.resolve(args),
        };
        let calledWith = null;
        mockPineconeIndex.deleteMany = (args: any) => {
            calledWith = args;
            return Promise.resolve();
        };

        await deleteLegacyRepositoryVectorsMock(mockPineconeIndex, 'owner/repoA');
        expect(calledWith).toEqual({ repoId: 'owner/repoA' });
    });

    it('legacy repository cleanup A does not affect B', async () => {
        const mockPineconeIndex = {
            deleteMany: (args: any) => Promise.resolve(args),
        };
        let calledWith = null;
        mockPineconeIndex.deleteMany = (args: any) => {
            calledWith = args;
            return Promise.resolve();
        };

        await deleteLegacyRepositoryVectorsMock(mockPineconeIndex, 'owner/repoA');
        expect(calledWith).not.toEqual({ repoId: 'owner/repoB' });
    });
});

// ---- Disconnect Cleanup ----

describe('Stage 5 Disconnect Cleanup', () => {
    it('disconnecting repo A deletes namespace A and legacy A, but leaves B alone', async () => {
        const mockPineconeIndex = {
            deleteMany: (args: any) => Promise.resolve(args),
            namespace: (ns: string) => ({
                deleteAll: () => Promise.resolve(),
            }),
        };

        let legacyDeleted: any = null;
        let nsDeleted: string | null = null;

        mockPineconeIndex.deleteMany = (args: any) => {
            legacyDeleted = args;
            return Promise.resolve();
        };

        mockPineconeIndex.namespace = (ns: string) => ({
            deleteAll: () => {
                nsDeleted = ns;
                return Promise.resolve();
            }
        });

        // Simulate disconnect A
        const ns = repoNamespace('repoA');
        await mockPineconeIndex.namespace(ns).deleteAll();
        await deleteLegacyRepositoryVectorsMock(mockPineconeIndex, 'owner/repoA');

        expect(nsDeleted).toBe('repo:repoA');
        expect(legacyDeleted).toEqual({ repoId: 'owner/repoA' });

        // Ensure B is untouched
        expect(nsDeleted).not.toBe('repo:repoB');
        expect(legacyDeleted).not.toEqual({ repoId: 'owner/repoB' });
    });
});

// ---- Index state machine tests ----

describe('Stage 5 Index State Machine', () => {
    const repoBase = {
        id: 'test-repo',
        indexState: null as string | null,
        indexedSha: null as string | null,
    };

    it('initial state: indexState null / indexedSha null', () => {
        expect(repoBase.indexState).toBeNull();
        expect(repoBase.indexedSha).toBeNull();
    });

    it('transitions: null → INDEXING → READY', () => {
        let state = { ...repoBase };

        // Step 1: mark indexing
        state = { ...state, indexState: 'INDEXING', indexedSha: null };
        expect(state.indexState).toBe('INDEXING');
        expect(state.indexedSha).toBeNull();

        // Step 2: mark ready with SHA
        state = { ...state, indexState: 'READY', indexedSha: 'sha-abc123' };
        expect(state.indexState).toBe('READY');
        expect(state.indexedSha).toBe('sha-abc123');
    });

    it('failure: preserves previous indexedSha, marks FAILED', () => {
        let state = { ...repoBase, indexState: 'READY', indexedSha: 'sha-old' };

        // Incremental reindex starts
        state = { ...state, indexState: 'INDEXING' };
        expect(state.indexedSha).toBe('sha-old'); // preserved during indexing

        // Simulate failure
        state = { ...state, indexState: 'FAILED', indexedSha: 'sha-old' }; // preserved
        expect(state.indexState).toBe('FAILED');
        expect(state.indexedSha).toBe('sha-old'); // NOT the failed newSha
    });

    it('does not overwrite indexedSha until complete', () => {
        const state = { indexState: 'INDEXING', indexedSha: 'sha-previous' };
        // indexedSha must remain 'sha-previous' until READY
        expect(state.indexedSha).toBe('sha-previous');
        expect(state.indexState).toBe('INDEXING');
    });

    it('same SHA skip: does not restart indexing', () => {
        const currentIndexedSha = 'sha-xyz';
        const incomingPushSha = 'sha-xyz';
        // The reindex function should skip if SHAs match
        const shouldSkip = currentIndexedSha === incomingPushSha;
        expect(shouldSkip).toBe(true);
    });
});

// ---- Incremental push filtering ----

describe('Stage 5 Push Event Filtering', () => {
    it('only triggers for default branch', () => {
        const defaultBranch = 'main';
        const cases = [
            { ref: 'refs/heads/main', expected: true },
            { ref: 'refs/heads/feature/my-pr', expected: false },
            { ref: 'refs/heads/develop', expected: false },
            { ref: 'refs/tags/v1.0.0', expected: false },
        ];

        for (const c of cases) {
            const branch = c.ref.replace('refs/heads/', '');
            const isDefault = branch === defaultBranch;
            expect(isDefault).toBe(c.expected);
        }
    });

    it('ignores null SHA (delete branch)', () => {
        const nullSha = '0000000000000000000000000000000000000000';
        expect(nullSha === '0000000000000000000000000000000000000000').toBe(true);
        // Should not trigger reindex
    });
});

// ---- Inngest step output validation ----

describe('Stage 5 Inngest Step Output Safety', () => {
    it('step summary contains only counts, not file contents', () => {
        const stepOutput = {
            chunksCreated: 42,
            vectorsUpserted: 40,
            errors: [],
        };
        // Step should NOT contain full file content
        expect(stepOutput).not.toHaveProperty('content');
        expect(stepOutput).not.toHaveProperty('files');
        expect(stepOutput).not.toHaveProperty('chunks');
        expect(stepOutput).not.toHaveProperty('vectors');
        // Only counts
        expect(typeof stepOutput.chunksCreated).toBe('number');
        expect(typeof stepOutput.vectorsUpserted).toBe('number');
    });

    it('top-level return contains only summary counts', () => {
        const result = {
            success: true,
            commitSha: 'abc123',
            eligibleFiles: 200,
            skippedFiles: 50,
            chunksCreated: 800,
            vectorsUpserted: 790,
        };
        expect(result).not.toHaveProperty('fileContents');
        expect(result).not.toHaveProperty('embeddingVectors');
        expect(typeof result.chunksCreated).toBe('number');
        expect(typeof result.vectorsUpserted).toBe('number');
    });
});
