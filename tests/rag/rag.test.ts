/**
 * Stage 5 RAG v2 — Comprehensive Tests
 *
 * Tests cover:
 * - Chunking (small file, 500-line file, boundary, overlap, symbol detection, content hash)
 * - Vector IDs (collision safety, content change, chunk index change, repo isolation)
 * - Indexing policy (secret filtering, binary exclusion, directory exclusion)
 * - Query builder (rule ID, file path, finding context, bounded length)
 * - Context assembler (same-file dedup, token budget, diff hunks)
 * - Index state behavior
 * - Retrieval evaluation (hit@k)
 */

import { describe, it, expect } from 'vitest';
import {
    chunkFile,
    makeVectorId,
    contentHash8,
    detectLanguage,
} from '../../src/modules/ai/lib/chunker';
import {
    isPathAllowed,
    isContentAllowed,
    MAX_FILE_SIZE_BYTES,
} from '../../src/modules/ai/lib/indexing-policy';
import {
    buildFindingQuery,
    FindingQueryContext,
} from '../../src/modules/ai/lib/query-builder';
import {
    assembleContext,
    FindingWindow,
    RetrievedChunk,
} from '../../src/modules/ai/lib/context-assembler';

// ============================================================
// CHUNKER TESTS
// ============================================================

describe('Stage 5 Chunker', () => {
    const REPO_ID = 'repo-abc';
    const COMMIT = 'abc1234def5678';

    it('chunks a small file (< MAX_LINES) as a single chunk', () => {
        const content = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join('\n');
        const chunks = chunkFile(REPO_ID, 'src/small.ts', COMMIT, content);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].startLine).toBe(1);
        expect(chunks[0].endLine).toBe(20);
        expect(chunks[0].chunkIndex).toBe(0);
        expect(chunks[0].repositoryId).toBe(REPO_ID);
        expect(chunks[0].commitSha).toBe(COMMIT);
        expect(chunks[0].language).toBe('typescript');
    });

    it('produces multiple chunks for a 500-line file', () => {
        const content = Array.from({ length: 500 }, (_, i) => `const x${i} = ${i};`).join('\n');
        const chunks = chunkFile(REPO_ID, 'src/large.ts', COMMIT, content);
        expect(chunks.length).toBeGreaterThan(1);
        // Each chunk must be within bounds
        for (const chunk of chunks) {
            const lines = chunk.endLine - chunk.startLine + 1;
            expect(lines).toBeGreaterThan(0);
            expect(lines).toBeLessThanOrEqual(130); // MAX + overlap tolerance
        }
    });

    it('applies overlap between consecutive chunks', () => {
        const content = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join('\n');
        const chunks = chunkFile(REPO_ID, 'src/overlap.ts', COMMIT, content);
        expect(chunks.length).toBeGreaterThan(1);
        // Consecutive chunks should have overlapping line ranges
        for (let i = 1; i < chunks.length; i++) {
            expect(chunks[i].startLine).toBeLessThan(chunks[i - 1].endLine + 1);
        }
    });

    it('includes deterministic content hash', () => {
        const content = 'const a = 1;\nconst b = 2;';
        const chunks = chunkFile(REPO_ID, 'src/hash.ts', COMMIT, content);
        expect(chunks[0].contentHash).toBeDefined();
        expect(chunks[0].contentHash).toHaveLength(16);

        // Same content → same hash
        const chunks2 = chunkFile(REPO_ID, 'src/hash.ts', COMMIT, content);
        expect(chunks2[0].contentHash).toBe(chunks[0].contentHash);

        // Changed content → different hash
        const chunks3 = chunkFile(REPO_ID, 'src/hash.ts', COMMIT, content + '\nconst c = 3;');
        expect(chunks3[0].contentHash).not.toBe(chunks[0].contentHash);
    });

    it('detects function symbols in TypeScript', () => {
        const content = [
            'import { Foo } from "./foo";',
            '',
            'export function processData(items: Foo[]) {',
            '    return items.map(x => x.value);',
            '}',
        ].join('\n');
        const chunks = chunkFile(REPO_ID, 'src/symbols.ts', COMMIT, content);
        expect(chunks[0].symbol).toBe('processData');
        expect(chunks[0].kind).toBe('function');
    });

    it('produces empty chunk array for empty file', () => {
        const chunks = chunkFile(REPO_ID, 'src/empty.ts', COMMIT, '');
        expect(chunks).toHaveLength(0);
    });

    it('does not create a single massive chunk for large file', () => {
        const content = Array.from({ length: 1000 }, (_, i) => `// line ${i}`).join('\n');
        const chunks = chunkFile(REPO_ID, 'src/huge.ts', COMMIT, content);
        for (const chunk of chunks) {
            const lines = chunk.endLine - chunk.startLine + 1;
            expect(lines).toBeLessThanOrEqual(140);
        }
    });

    it('detects language from extension', () => {
        expect(detectLanguage('foo.ts')).toBe('typescript');
        expect(detectLanguage('bar.py')).toBe('python');
        expect(detectLanguage('baz.go')).toBe('go');
        expect(detectLanguage('qux.unknown')).toBe('text');
    });
});

// ============================================================
// VECTOR ID TESTS
// ============================================================

describe('Stage 5 Vector IDs', () => {
    it('produces deterministic IDs for same content/location', () => {
        const id1 = makeVectorId('repo-A', 'src/foo.ts', 0, 'abc12345deadbeef');
        const id2 = makeVectorId('repo-A', 'src/foo.ts', 0, 'abc12345deadbeef');
        expect(id1).toBe(id2);
    });

    it('distinguishes a/b_c.ts from a_b/c.ts (path collision safety)', () => {
        const id1 = makeVectorId('repo-A', 'a/b_c.ts', 0, 'hash1234hash5678');
        const id2 = makeVectorId('repo-A', 'a_b/c.ts', 0, 'hash1234hash5678');
        expect(id1).not.toBe(id2);
    });

    it('changes ID when content changes', () => {
        const id1 = makeVectorId('repo-A', 'src/foo.ts', 0, 'aaaa1111bbbb2222');
        const id2 = makeVectorId('repo-A', 'src/foo.ts', 0, 'cccc3333dddd4444');
        expect(id1).not.toBe(id2);
    });

    it('changes ID when chunk index changes', () => {
        const id1 = makeVectorId('repo-A', 'src/foo.ts', 0, 'aaaa1111bbbb2222');
        const id2 = makeVectorId('repo-A', 'src/foo.ts', 1, 'aaaa1111bbbb2222');
        expect(id1).not.toBe(id2);
    });

    it('isolates IDs between repositories', () => {
        const id1 = makeVectorId('repo-A', 'src/foo.ts', 0, 'aaaa1111bbbb2222');
        const id2 = makeVectorId('repo-B', 'src/foo.ts', 0, 'aaaa1111bbbb2222');
        expect(id1).not.toBe(id2);
        expect(id1.startsWith('repo-A#')).toBe(true);
        expect(id2.startsWith('repo-B#')).toBe(true);
    });

    it('normalises backslash paths', () => {
        const id1 = makeVectorId('repo-A', 'src\\foo\\bar.ts', 0, 'hash1234hash5678');
        const id2 = makeVectorId('repo-A', 'src/foo/bar.ts', 0, 'hash1234hash5678');
        expect(id1).toBe(id2);
    });

    it('contentHash8 produces 16-char hex', () => {
        const h = contentHash8('hello world');
        expect(h).toHaveLength(16);
        expect(h).toMatch(/^[0-9a-f]+$/);
    });
});

// ============================================================
// INDEXING POLICY TESTS (secret filtering, binary exclusion)
// ============================================================

describe('Stage 5 Indexing Policy', () => {
    describe('path filtering', () => {
        it('allows normal source files', () => {
            expect(isPathAllowed('src/index.ts').allowed).toBe(true);
            expect(isPathAllowed('lib/utils.py').allowed).toBe(true);
            expect(isPathAllowed('main.go').allowed).toBe(true);
        });

        it('excludes node_modules', () => {
            const r = isPathAllowed('node_modules/lodash/index.js');
            expect(r.allowed).toBe(false);
            expect(r.reason).toBe('excluded_directory');
        });

        it('excludes vendor', () => {
            expect(isPathAllowed('vendor/github.com/pkg.go').allowed).toBe(false);
        });

        it('excludes dist/build outputs', () => {
            expect(isPathAllowed('dist/bundle.js').allowed).toBe(false);
            expect(isPathAllowed('build/output.js').allowed).toBe(false);
        });

        it('excludes binary/image extensions', () => {
            expect(isPathAllowed('assets/logo.png').allowed).toBe(false);
            expect(isPathAllowed('docs/manual.pdf').allowed).toBe(false);
            expect(isPathAllowed('archive.zip').allowed).toBe(false);
        });

        it('excludes .env files (secret filtering)', () => {
            expect(isPathAllowed('.env').allowed).toBe(false);
            expect(isPathAllowed('.env.local').allowed).toBe(false);
            expect(isPathAllowed('.env.production').allowed).toBe(false);
        });

        it('excludes private key files', () => {
            expect(isPathAllowed('id_rsa').allowed).toBe(false);
            expect(isPathAllowed('server.key').allowed).toBe(false);
            expect(isPathAllowed('cert.pem').allowed).toBe(false);
        });

        it('excludes credential files', () => {
            expect(isPathAllowed('secrets.json').allowed).toBe(false);
            expect(isPathAllowed('credentials.yaml').allowed).toBe(false);
        });

        it('excludes lockfiles', () => {
            expect(isPathAllowed('package-lock.json').allowed).toBe(false);
            expect(isPathAllowed('yarn.lock').allowed).toBe(false);
            expect(isPathAllowed('Cargo.lock').allowed).toBe(false);
        });

        it('excludes minified files', () => {
            expect(isPathAllowed('dist/app.min.js').allowed).toBe(false);
            expect(isPathAllowed('styles.min.css').allowed).toBe(false);
        });
    });

    describe('content size filtering', () => {
        it('allows files within size limit', () => {
            expect(isContentAllowed(1000).allowed).toBe(true);
            expect(isContentAllowed(MAX_FILE_SIZE_BYTES - 1).allowed).toBe(true);
        });

        it('rejects files over size limit', () => {
            const r = isContentAllowed(MAX_FILE_SIZE_BYTES + 1);
            expect(r.allowed).toBe(false);
            expect(r.reason).toBe('over_size_limit');
        });
    });
});

// ============================================================
// QUERY BUILDER TESTS
// ============================================================

describe('Stage 5 Query Builder', () => {
    const baseCtx: FindingQueryContext = {
        ruleId: 'semgrep.security.sql-injection',
        ruleMessage: 'Potential SQL injection via unsanitized input',
        filePath: 'src/db/queries.ts',
        startLine: 42,
        endLine: 50,
        severity: 'HIGH',
        category: 'SECURITY',
        codeSnippet: "const result = db.query(`SELECT * FROM users WHERE id = ${userId}`);",
        language: 'typescript',
        symbol: 'getUserById',
        cwe: 'CWE-89',
        owasp: 'A03:2021',
    };

    it('includes rule ID in query', () => {
        const q = buildFindingQuery(baseCtx);
        expect(q).toContain('semgrep.security.sql-injection');
    });

    it('includes file path in query', () => {
        const q = buildFindingQuery(baseCtx);
        expect(q).toContain('src/db/queries.ts');
    });

    it('includes finding message', () => {
        const q = buildFindingQuery(baseCtx);
        expect(q).toContain('SQL injection');
    });

    it('includes CWE/OWASP metadata', () => {
        const q = buildFindingQuery(baseCtx);
        expect(q).toContain('CWE-89');
        expect(q).toContain('A03:2021');
    });

    it('includes code snippet', () => {
        const q = buildFindingQuery(baseCtx);
        expect(q).toContain('getUserById');
    });

    it('caps query at 1200 chars', () => {
        const ctx = { ...baseCtx, codeSnippet: 'x'.repeat(5000) };
        const q = buildFindingQuery(ctx);
        expect(q.length).toBeLessThanOrEqual(1200);
    });

    it('caps code snippet at 400 chars', () => {
        const ctx = { ...baseCtx, codeSnippet: 'a'.repeat(5000) };
        const q = buildFindingQuery(ctx);
        // Snippet section should not contain more than 400 chars of 'a'
        const snippetSection = q.split('Code:\n')[1]?.slice(0, 500) ?? '';
        expect(snippetSection.length).toBeLessThanOrEqual(400);
    });

    it('does not use PR title/description as content', () => {
        // Query builder has no field for PR title/description
        // Verify that the query only uses structured finding data
        const q = buildFindingQuery(baseCtx);
        expect(q).not.toContain('PR Title');
        expect(q).not.toContain('pull request title');
    });
});

// ============================================================
// CONTEXT ASSEMBLER TESTS
// ============================================================

describe('Stage 5 Context Assembler', () => {
    const window: FindingWindow = {
        filePath: 'src/db/queries.ts',
        startLine: 40,
        endLine: 55,
        text: Array.from({ length: 16 }, (_, i) => `const line${i + 40} = ${i};`).join('\n'),
    };

    const makeChunk = (path: string, start: number, end: number, idx: number): RetrievedChunk => ({
        path,
        startLine: start,
        endLine: end,
        text: Array.from({ length: end - start + 1 }, (_, i) => `// ${path}:${start + i}`).join('\n'),
        score: 0.9 - idx * 0.05,
        chunkIndex: idx,
        language: 'typescript',
    });

    it('removes same-file chunks overlapping finding window', () => {
        const overlapping = makeChunk('src/db/queries.ts', 42, 60, 0);   // overlaps window
        const unrelated = makeChunk('src/utils.ts', 1, 30, 0);

        const ctx = assembleContext(window, [], [overlapping, unrelated]);
        const paths = ctx.retrievedChunks.map(c => c.path);
        expect(paths).not.toContain('src/db/queries.ts');
        expect(paths).toContain('src/utils.ts');
    });

    it('respects maximum retrieved chunks', () => {
        const chunks = Array.from({ length: 20 }, (_, i) =>
            makeChunk(`src/file${i}.ts`, 1, 10, i)
        );
        const ctx = assembleContext(window, [], chunks, 3);
        expect(ctx.retrievedChunks.length).toBeLessThanOrEqual(3);
    });

    it('respects token budget', () => {
        const bigChunks = Array.from({ length: 30 }, (_, i) =>
            makeChunk(`src/big${i}.ts`, 1, 200, i)
        );
        // Inflate text to consume tokens
        for (const c of bigChunks) {
            c.text = 'a'.repeat(3000);
        }
        const ctx = assembleContext(window, [], bigChunks, 20);
        expect(ctx.totalTokenEstimate).toBeLessThanOrEqual(6500); // slight tolerance
    });

    it('includes diff hunks in context', () => {
        const hunk = '@@ -42,5 +42,7 @@\n+const newLine = true;';
        const ctx = assembleContext(window, [hunk], []);
        expect(ctx.diffHunks).toContain(hunk);
    });

    it('deduplicates chunks by path+chunkIndex', () => {
        const chunk1 = makeChunk('src/utils.ts', 1, 30, 0);
        const chunk2 = makeChunk('src/utils.ts', 1, 30, 0); // exact duplicate
        const ctx = assembleContext(window, [], [chunk1, chunk2]);
        expect(ctx.retrievedChunks.length).toBe(1);
    });
});

// ============================================================
// RETRIEVAL EVALUATION (hit@k)
// ============================================================

describe('deterministic Stage 5 smoke/evaluation set', () => {
    /**
     * Deterministic mock: given a finding context, does the query contain
     * the expected signal to retrieve the right chunk?
     *
     * This is a functional evaluation of query quality, not a live Pinecone test.
     * hit@k = fraction of test cases where the expected chunk is retrievable
     * given the query covers the right signals.
     */

    interface EvalCase {
        name: string;
        finding: FindingQueryContext;
        expectedSignals: string[]; // signals that should appear in query for retrieval to work
    }

    const evalCases: EvalCase[] = [
        {
            name: 'SQL injection in TypeScript',
            finding: {
                ruleId: 'sql-injection',
                ruleMessage: 'Unsanitized SQL query',
                filePath: 'src/db/user-queries.ts',
                startLine: 15,
                endLine: 20,
                severity: 'HIGH',
                category: 'SECURITY',
                codeSnippet: 'db.query(`SELECT * FROM ${table}`)',
                language: 'typescript',
                cwe: 'CWE-89',
            },
            expectedSignals: ['sql-injection', 'src/db/user-queries.ts', 'CWE-89'],
        },
        {
            name: 'Unused variable in JavaScript',
            finding: {
                ruleId: 'no-unused-vars',
                ruleMessage: 'Variable declared but never used',
                filePath: 'lib/helpers.js',
                startLine: 42,
                endLine: 42,
                severity: 'LOW',
                category: 'STYLE',
                codeSnippet: 'const unusedValue = computeExpensive();',
                language: 'javascript',
            },
            expectedSignals: ['no-unused-vars', 'lib/helpers.js'],
        },
        {
            name: 'Path traversal in Python',
            finding: {
                ruleId: 'path-traversal',
                ruleMessage: 'Potential path traversal via user-controlled input',
                filePath: 'api/files.py',
                startLine: 88,
                endLine: 92,
                severity: 'HIGH',
                category: 'SECURITY',
                codeSnippet: 'open(os.path.join(base, user_input))',
                language: 'python',
                cwe: 'CWE-22',
                owasp: 'A01:2021',
            },
            expectedSignals: ['path-traversal', 'api/files.py', 'CWE-22'],
        },
    ];

    let hits = 0;
    const k = 4;

    for (const evalCase of evalCases) {
        it(`hit@${k}: ${evalCase.name}`, () => {
            const query = buildFindingQuery(evalCase.finding);
            let hit = false;

            for (const signal of evalCase.expectedSignals) {
                if (query.includes(signal)) {
                    hit = true;
                    break;
                }
            }

            // A query that contains key signals is expected to retrieve relevant chunks
            expect(hit).toBe(true);
            if (hit) hits++;
        });
    }

    it(`overall hit@${k} baseline is 100%`, () => {
        // All eval cases pass (functional, not statistical)
        expect(hits).toBe(evalCases.length);
    });
});
