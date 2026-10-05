import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let cachedHash: string | null = null;

export function getRulesetId(): string {
    if (cachedHash) return cachedHash;
    
    // In production this might be a folder or a single file. We read the deterministic file here.
    const rulePath = path.resolve(process.cwd(), 'rules/semgrep/prism-test.yaml');
    
    if (!fs.existsSync(rulePath)) {
        return 'sha256:unknown';
    }

    const content = fs.readFileSync(rulePath, 'utf-8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    cachedHash = `sha256:${hash}`;
    return cachedHash;
}
