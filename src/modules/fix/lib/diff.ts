import { createPatch } from 'diff';
import crypto from 'crypto';
import { FixProposal } from './schema';

export interface PatchStats {
    unifiedDiff: string;
    diffSha256: string;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    baseBlobShas: Record<string, string>;
}

export function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Replace the first occurrence of `find` with `replace`, both treated as literals.
 * A function replacer is used so "$&", "$1", "$$" etc. in `replace` are not interpreted.
 */
export function applyLiteralEdit(content: string, find: string, replace: string): string {
    return content.replace(find, () => replace);
}

function gitHash(content: string): string {
    const buffer = Buffer.from(content, 'utf-8');
    const header = `blob ${buffer.length}\0`;
    const store = Buffer.concat([Buffer.from(header), buffer]);
    return crypto.createHash('sha1').update(store).digest('hex');
}

export function generateDeterministicPatch(proposal: FixProposal, baseFileContents: Record<string, string>): PatchStats {
    const fileEdits = new Map<string, typeof proposal.edits>();
    for (const edit of proposal.edits) {
        if (!fileEdits.has(edit.path)) {
            fileEdits.set(edit.path, []);
        }
        fileEdits.get(edit.path)!.push(edit);
    }

    let fullDiff = "";
    let linesAdded = 0;
    let linesRemoved = 0;
    const baseBlobShas: Record<string, string> = {};

    // Sort paths for determinism
    const sortedPaths = Array.from(fileEdits.keys()).sort();

    for (const path of sortedPaths) {
        const edits = fileEdits.get(path)!;
        const originalContent = baseFileContents[path];
        if (originalContent === undefined) {
            throw new Error(`File ${path} not found in base contents`);
        }

        baseBlobShas[path] = gitHash(originalContent);

        let newContent = originalContent;
        
        // We must apply replacements safely. If there are multiple edits in one file, 
        // we must be careful with indices. Because we use exact match `replace`, 
        // it's generally safe if they don't overlap. We already guard that there is exactly 1 match.
        // Let's just run them sequentially.
        for (const edit of edits) {
            if (edit.find !== "") {
                newContent = applyLiteralEdit(newContent, edit.find, edit.replace);
            } else {
                // If it's a pure addition, not supported by exact match replace nicely unless we define how.
                // Our schema says "MUST exactly match existing file content".
            }
            
            linesRemoved += edit.find ? edit.find.split('\n').length : 0;
            linesAdded += edit.replace ? edit.replace.split('\n').length : 0;
        }

        // Generate unified diff for this file
        // createPatch(fileName, oldStr, newStr, oldHeader, newHeader, options)
        const fileDiff = createPatch(
            `b/${path}`, 
            originalContent, 
            newContent, 
            `a/${path}`, 
            `b/${path}`, 
            { context: 3 }
        );

        // diff package adds a header that includes things like timestamps. We want it strictly deterministic.
        // Strip out the first two lines (--- and +++ headers that might have dates) if needed, 
        // actually createPatch without headers just uses the strings we gave it.
        // Let's manually strip timestamp if createPatch adds it: it usually does `\t` and timestamp.
        const cleanDiff = fileDiff.split('\n').map(line => {
            if (line.startsWith('--- ') || line.startsWith('+++ ')) {
                return line.split('\t')[0]; // Remove timestamp
            }
            return line;
        }).join('\n');

        fullDiff += cleanDiff + '\n';
    }

    return {
        unifiedDiff: fullDiff,
        diffSha256: sha256(fullDiff),
        filesChanged: sortedPaths.length,
        linesAdded,
        linesRemoved,
        baseBlobShas
    };
}
