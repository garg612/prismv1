import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Review Inngest Function Secret Handling', () => {
  it('does not return GitHub token from step', async () => {
    const fileContent = fs.readFileSync(path.resolve(__dirname, '../../src/inngest/functions/review.ts'), 'utf-8');
    expect(fileContent).not.toMatch(/return\s*\{[^}]*token\s*:/);
    expect(fileContent).not.toContain('return {...diff,token:account.accessToken}');
  });
});
