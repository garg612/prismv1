import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export interface ASTMetrics {
    fileSizeLines: number;
    functionLength: number | null;
    cyclomaticComplexity: number | null;
}

export function extractASTMetrics(filePath: string, findingLine: number): ASTMetrics {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');
    const fileSizeLines = lines.length;

    // Only parse JS/TS for AST metrics
    if (!filePath.endsWith('.js') && !filePath.endsWith('.ts') && !filePath.endsWith('.jsx') && !filePath.endsWith('.tsx')) {
        return { fileSizeLines, functionLength: null, cyclomaticComplexity: null };
    }

    const sourceFile = ts.createSourceFile(
        filePath,
        fileContent,
        ts.ScriptTarget.Latest,
        true
    );

    let targetFunction: ts.Node | null = null;
    let targetFunctionLength: number | null = null;
    let targetComplexity: number | null = null;

    // Find the narrowest enclosing function
    function visit(node: ts.Node) {
        const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

        if (findingLine >= startLine && findingLine <= endLine) {
            if (ts.isFunctionDeclaration(node) || 
                ts.isMethodDeclaration(node) || 
                ts.isArrowFunction(node) ||
                ts.isFunctionExpression(node)) {
                targetFunction = node;
                targetFunctionLength = endLine - startLine + 1;
            }
            ts.forEachChild(node, visit);
        }
    }

    visit(sourceFile);

    if (targetFunction) {
        let complexity = 1;

        // Definition: Complexity = 1 + branching nodes
        // Branching nodes: if, for, while, do, case, catch, &&, ||, ?
        function countComplexity(node: ts.Node) {
            if (
                ts.isIfStatement(node) ||
                ts.isForStatement(node) ||
                ts.isForInStatement(node) ||
                ts.isForOfStatement(node) ||
                ts.isWhileStatement(node) ||
                ts.isDoStatement(node) ||
                ts.isCaseClause(node) ||
                ts.isCatchClause(node)
            ) {
                complexity++;
            } else if (ts.isBinaryExpression(node)) {
                if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                    node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                    complexity++;
                }
            } else if (ts.isConditionalExpression(node)) {
                complexity++;
            }
            ts.forEachChild(node, countComplexity);
        }

        countComplexity(targetFunction);
        targetComplexity = complexity;
    }

    return {
        fileSizeLines,
        functionLength: targetFunctionLength,
        cyclomaticComplexity: targetComplexity
    };
}

export function countRepositoryLOC(workDir: string): number {
    let totalLines = 0;
    const extensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.rs'];

    function walk(dir: string) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (file === 'node_modules' || file === '.git' || file === 'dist' || file === 'build') continue;
                walk(fullPath);
            } else if (stat.isFile()) {
                if (extensions.some(ext => file.endsWith(ext))) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        totalLines += content.split('\n').length;
                    } catch {
                        // ignore unreadable files
                    }
                }
            }
        }
    }

    try {
        walk(workDir);
    } catch {
        // ignore root errors
    }
    return totalLines;
}

export function validateSyntax(filePath: string): boolean {
    if (filePath.endsWith('.js') || filePath.endsWith('.ts') || filePath.endsWith('.jsx') || filePath.endsWith('.tsx')) {
        const program = ts.createProgram([filePath], { noResolve: true, target: ts.ScriptTarget.Latest, allowJs: true });
        const sourceFile = program.getSourceFile(filePath);
        if (!sourceFile) return false;
        const diagnostics = program.getSyntacticDiagnostics(sourceFile);
        return diagnostics.length === 0;
    }
    // For other files, if we don't have a parser, we assume they apply successfully or rely on Semgrep
    return true;
}
