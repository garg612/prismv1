import crypto from 'crypto';

export function normalizeSnippet(snippet: string): string {
    // Remove leading/trailing whitespace, condense multiple spaces/newlines, remove single line comments
    return snippet
        .replace(/\/\/.*$/gm, '') // remove // comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // remove /* */ comments
        .replace(/\s+/g, ' ') // condense whitespace
        .trim();
}

export function generateFingerprint(ruleId: string, filePath: string, snippet: string): string {
    const normalizedSnippet = normalizeSnippet(snippet);
    const payload = `${ruleId}:${filePath}:${normalizedSnippet}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
}
