import { describe, it, expect } from 'vitest';
import { normalizeFinding } from '../../src/modules/scanners/semgrep/normalize';
import { SemgrepFinding } from '../../src/modules/scanners/semgrep/schema';

describe('Normalize finding tests', () => {
    it('normalizes finding safely', () => {
        const raw: SemgrepFinding = {
            check_id: 'rule-id',
            path: 'src/test.js',
            start: { line: 1, col: 1 },
            end: { line: 2, col: 2 },
            extra: {
                message: 'bad code',
                severity: 'WARNING',
                metadata: { category: 'security' },
                lines: 'const a = 1;'
            }
        };

        const result = normalizeFinding(raw);
        expect(result.filePath).toEqual('src/test.js');
        expect(result.category).toEqual('SECURITY');
        expect(result.severity).toEqual('MEDIUM'); // WARNING -> MEDIUM
    });

    it('rejects a traversal path instead of rewriting it into a different file', () => {
        const raw: SemgrepFinding = {
            check_id: 'rule-id',
            path: '../src/test.js', // malicious path
            start: { line: 1, col: 1 },
            end: { line: 2, col: 2 },
            extra: { message: 'bad code', severity: 'WARNING', lines: 'const a = 1;' }
        };
        expect(() => normalizeFinding(raw)).toThrow(/not repository-relative/);
    });
});
