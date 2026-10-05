import { describe, it, expect } from 'vitest';
import { getRulesetId } from '../../src/modules/scanners/semgrep/ruleset';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

describe('Ruleset Hash Determinism', () => {
    it('returns a deterministic content-addressed sha256 hash', () => {
        const hash1 = getRulesetId();
        const hash2 = getRulesetId();
        expect(hash1).toBe(hash2);
        
        expect(hash1.startsWith('sha256:')).toBe(true);

        const rulePath = path.resolve(process.cwd(), 'rules/semgrep/prism-test.yaml');
        const content = fs.readFileSync(rulePath, 'utf-8');
        const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
        
        expect(hash1).toBe(`sha256:${expectedHash}`);
    });
});
