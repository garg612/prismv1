export class NonCanonicalPathError extends Error {
    constructor(rawPath: string) {
        super(`Path is not repository-relative: ${JSON.stringify(rawPath)}`);
        this.name = 'NonCanonicalPathError';
    }
}

/**
 * The single definition of a finding path: POSIX separators, relative to the
 * repository root, no leading "./". Anything that cannot be expressed that way
 * (absolute paths, drive letters, ".." segments) is rejected rather than rewritten,
 * because a rewritten path silently points at a different file.
 */
export function toRepoRelativePath(rawPath: string): string {
    let p = rawPath.replace(/\\/g, '/');
    while (p.startsWith('./')) p = p.substring(2);

    const segments = p.split('/');
    if (
        p === '' ||
        p.startsWith('/') ||
        /^[A-Za-z]:/.test(p) ||
        p.includes('\0') ||
        segments.some(s => s === '' || s === '.' || s === '..')
    ) {
        throw new NonCanonicalPathError(rawPath);
    }
    return p;
}
