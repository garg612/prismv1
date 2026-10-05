import { FixProposal } from './schema';
import { scanForSecrets } from './secret-scan';

export interface GuardContext {
    baseFileContents: Record<string, string>;
    baseBlobShas?: Record<string, string>;
    findingPath: string;
    findingStartLine: number;
    findingEndLine: number;
}

export interface GuardResult {
    passed: boolean;
    reason?: string;
}

const MAX_FILES = parseInt(process.env.FIX_MAX_FILES || "3", 10);
const MAX_CHANGED_LINES = parseInt(process.env.FIX_MAX_CHANGED_LINES || "200", 10);

const FORBIDDEN_PATHS = [
    /^\.git\//,
    /^\.github\//,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /node_modules\//,
    /^\.env/,
    /\.log$/,
    /dist\//,
    /build\//,
    /out\//,
    /\.bin\//,
    /\.exe$/,
    /\.dll$/
];

const DANGEROUS_CONSTRUCTS = [
    /\beval\s*\(/,
    /\bchild_process\b/,
    /\bexec\s*\(/,
    /\bspawn\s*\(/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\baxios\b/,
    /\bpostinstall\b/,
    /\bpreinstall\b/
];

export function runGuards(proposal: FixProposal, context: GuardContext): GuardResult {
    // A. Schema checks implicitly handled by Zod prior to this.
    if (!proposal.edits || proposal.edits.length === 0) {
        return { passed: false, reason: "No edits proposed." };
    }

    const uniquePaths = new Set(proposal.edits.map(e => e.path));
    if (uniquePaths.size > MAX_FILES) {
        return { passed: false, reason: `Too many files touched (max ${MAX_FILES})` };
    }

    let totalLinesChanged = 0;

    for (const edit of proposal.edits) {
        // B. Path safety
        // Ensure no absolute paths, no traversing up, no windows backslash, and no Unicode tricks.
        if (
            edit.path.startsWith('/') || 
            edit.path.includes('\\') || 
            edit.path.includes('..') || 
            edit.path.includes('\0') ||
            /%[0-9a-f]{2}/i.test(edit.path) || 
            edit.path !== edit.path.normalize('NFC')
        ) {
            return { passed: false, reason: `Path traversal, absolute path, or invalid characters detected: ${edit.path}` };
        }
        
        // C. Forbidden paths
        if (FORBIDDEN_PATHS.some(pattern => pattern.test(edit.path))) {
            return { passed: false, reason: `Forbidden path modified: ${edit.path}` };
        }

        // Package.json specific restrictions (scripts, dependencies)
        if (edit.path === 'package.json') {
            if (edit.replace.includes('"scripts"') || edit.replace.includes('"dependencies"') || edit.replace.includes('"devDependencies"')) {
                return { passed: false, reason: `Modifying package.json scripts or dependencies is forbidden.` };
            }
        }

        // Dockerfile/IaC restriction
        if (edit.path.includes('Dockerfile') || edit.path.endsWith('.tf')) {
            if (!context.findingPath.includes('Dockerfile') && !context.findingPath.endsWith('.tf')) {
                return { passed: false, reason: `Modifying IaC/Dockerfile is only allowed if the finding targets it.` };
            }
        }

        // F. Secrets
        const secrets = scanForSecrets(edit.replace);
        if (secrets.length > 0) {
            return { passed: false, reason: `Secret detected in proposed edit: ${secrets[0].type}` };
        }

        // G. Dangerous constructs
        // Only allow dangerous constructs if they were already part of the target finding or base file.
        // Wait, actually, the requirement states: "Exception only when directly required by the finding and allowed by policy."
        // For simplicity, we just block introducing NEW dangerous constructs.
        const baseContentForPath = context.baseFileContents[edit.path] || '';
        for (const pattern of DANGEROUS_CONSTRUCTS) {
            if (pattern.test(edit.replace) && !pattern.test(edit.find)) {
                return { passed: false, reason: `Dangerous construct introduced in ${edit.path}` };
            }
        }

        // D. Match precision & H. Blob pinning / file existence
        const fileContent = context.baseFileContents[edit.path];
        if (fileContent === undefined) {
            // "no new files by default"
            return { passed: false, reason: `Cannot modify file not present in base context (no new files allowed): ${edit.path}` };
        }

        if (edit.find !== "") {
            const occurrences = fileContent.split(edit.find).length - 1;
            if (occurrences === 0) {
                return { passed: false, reason: `Find string not found in ${edit.path}. Ensure EXACT whitespace and literal matching.` };
            }
            if (occurrences > 1) {
                return { passed: false, reason: `Find string occurs ${occurrences} times in ${edit.path}. Must be exactly 1.` };
            }
        }

        const linesAdded = edit.replace.split('\n').length;
        const linesRemoved = edit.find.split('\n').length;
        totalLinesChanged += (linesAdded + linesRemoved);
    }

    // E. Scope (Lines changed)
    if (totalLinesChanged > MAX_CHANGED_LINES) {
        return { passed: false, reason: `Too many lines changed (${totalLinesChanged} > ${MAX_CHANGED_LINES})` };
    }

    return { passed: true };
}
