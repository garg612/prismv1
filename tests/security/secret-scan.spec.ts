/**
 * Stage 10: Automated Secret Scanner
 * 
 * Scans the codebase for hardcoded secrets, leaked tokens, and
 * sensitive data that should never appear in source code, logs,
 * or exported artifacts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

const SECRET_PATTERNS = [
    { name: 'GitHub PAT', pattern: /ghp_[A-Za-z0-9]{36,}/g },
    { name: 'GitHub OAuth', pattern: /gho_[A-Za-z0-9]{36,}/g },
    { name: 'GitHub User Token', pattern: /ghu_[A-Za-z0-9]{36,}/g },
    { name: 'GitHub App Token', pattern: /ghs_[A-Za-z0-9]{36,}/g },
    { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g },
    { name: 'Google API Key', pattern: /AIza[A-Za-z0-9_-]{35}/g },
    { name: 'Postgres URL', pattern: /postgres(ql)?:\/\/[^\s"']+@[^\s"']+/g },
    { name: 'Generic API Key Assignment', pattern: /(?:api_key|apikey|secret_key|secretkey)\s*=\s*['"][A-Za-z0-9]{20,}['"]/gi },
    { name: 'Private Key Block', pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/g },
    { name: 'E2B API Key', pattern: /e2b_[A-Za-z0-9]{20,}/g },
];

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yaml', '.yml', '.env.example'];
const SKIP_DIRS = ['node_modules', '.git', '.next', 'dist', '.generated', 'generated', '.system_generated'];
const SKIP_FILES = ['.env', '.env.local', 'secret-scan.spec.ts', 'observability.spec.ts'];
// Also skip test fixture files that legitimately reference secret patterns
const SKIP_PATTERNS = ['spec.ts', '.test.ts'];

function collectFiles(dir: string, files: string[] = []): string[] {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.includes(entry.name)) {
                    collectFiles(fullPath, files);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (SCAN_EXTENSIONS.includes(ext) && !SKIP_FILES.includes(entry.name)) {
                    const shouldSkip = SKIP_PATTERNS.some(p => fullPath.includes(p));
                    if (!shouldSkip) {
                        files.push(fullPath);
                    }
                }
            }
        }
    } catch {
        // Permission errors etc.
    }
    return files;
}

describe('Stage 10: Secret Scan', () => {
    const files = collectFiles(PROJECT_ROOT);

    it('scanned a meaningful number of files', () => {
        expect(files.length).toBeGreaterThan(50);
    });

    for (const { name, pattern } of SECRET_PATTERNS) {
        it(`no hardcoded ${name} in source files`, () => {
            const violations: string[] = [];
            for (const file of files) {
                try {
                    const content = fs.readFileSync(file, 'utf8');
                    const matches = content.match(pattern);
                    if (matches) {
                        const relPath = path.relative(PROJECT_ROOT, file);
                        violations.push(`${relPath}: found ${matches.length} match(es)`);
                    }
                } catch {
                    // Skip unreadable files
                }
            }
            expect(violations).toEqual([]);
        });
    }

    it('dataset.json (if exists) contains no secrets', () => {
        const dsPath = path.join(PROJECT_ROOT, 'dataset.json');
        if (!fs.existsSync(dsPath)) return;
        const content = fs.readFileSync(dsPath, 'utf8');
        for (const { name, pattern } of SECRET_PATTERNS) {
            expect(content.match(pattern)).toBeNull();
        }
    });

    it('.env is not committed to source (only .env.example)', () => {
        // .env should be in .gitignore
        const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const gitignore = fs.readFileSync(gitignorePath, 'utf8');
            expect(gitignore).toContain('.env');
        }
    });
});
