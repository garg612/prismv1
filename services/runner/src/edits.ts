import fs from 'fs';
import path from 'path';
import { toRepoRelativePath } from './semgrep';

export interface Edit {
    path: string;
    find: string;
    replace: string;
}

/**
 * Apply literal find/replace edits to an extracted tree.
 * Returns false (and stops) if any edit cannot be applied exactly as written:
 * a path outside the tree, a missing file, or a `find` string that is not present.
 */
export function applyEditsToTree(workDir: string, edits: Edit[] | undefined): boolean {
    if (!edits) return true;
    const root = path.resolve(workDir);

    for (const edit of edits) {
        let targetPath: string;
        try {
            targetPath = path.resolve(root, toRepoRelativePath(edit.path));
        } catch {
            return false;
        }
        if (!targetPath.startsWith(root + path.sep)) return false;
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) return false;

        const content = fs.readFileSync(targetPath, 'utf-8');
        if (edit.find === '' || !content.includes(edit.find)) return false;

        // Function replacer: "$&", "$1", "$$" in the replacement must stay literal.
        fs.writeFileSync(targetPath, content.replace(edit.find, () => edit.replace), 'utf-8');
    }
    return true;
}
