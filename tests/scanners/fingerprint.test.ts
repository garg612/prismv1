import { describe, it, expect } from 'vitest';
import { generateFingerprint } from '../../src/modules/scanners/semgrep/fingerprint';

describe('Fingerprint stability tests', () => {
    it('same finding + same source = same fingerprint', () => {
        const fp1 = generateFingerprint('rule-1', 'path/file.js', 'const a = 1;');
        const fp2 = generateFingerprint('rule-1', 'path/file.js', 'const a = 1;');
        expect(fp1).toEqual(fp2);
    });

    it('line number changes = same fingerprint (implicitly, fingerprint takes snippet, not line)', () => {
        // Fingerprint only depends on ruleId, path, and snippet
        const fp1 = generateFingerprint('rule-1', 'path/file.js', 'const a = 1;');
        const fp2 = generateFingerprint('rule-1', 'path/file.js', 'const a = 1;');
        expect(fp1).toEqual(fp2);
    });

    it('irrelevant whitespace changes = same fingerprint', () => {
        const fp1 = generateFingerprint('rule-1', 'path/file.js', 'const   a =    1;\n\n');
        const fp2 = generateFingerprint('rule-1', 'path/file.js', 'const a = 1;');
        expect(fp1).toEqual(fp2);
    });

    it('different rule = different fingerprint', () => {
        const fp1 = generateFingerprint('rule-1', 'path/file.js', 'const a = 1;');
        const fp2 = generateFingerprint('rule-2', 'path/file.js', 'const a = 1;');
        expect(fp1).not.toEqual(fp2);
    });

    it('different file = different fingerprint', () => {
        const fp1 = generateFingerprint('rule-1', 'path/file1.js', 'const a = 1;');
        const fp2 = generateFingerprint('rule-1', 'path/file2.js', 'const a = 1;');
        expect(fp1).not.toEqual(fp2);
    });

    it('different matched semantic text = different fingerprint', () => {
        const fp1 = generateFingerprint('rule-1', 'path/file.js', 'const a = 1;');
        const fp2 = generateFingerprint('rule-1', 'path/file.js', 'const b = 2;');
        expect(fp1).not.toEqual(fp2);
    });
});
