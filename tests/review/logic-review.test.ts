import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/ai', () => ({
    getReviewModel: () => { throw new Error('the real model must not be called in unit tests'); },
    getReviewModelName: () => 'test-model',
}));

import { isReviewableFile, parseDiffFiles, renderDiffFile, selectFilesForReview } from '../../src/modules/logic-review/lib/diff-files';
import { buildLogicReviewPrompt, LOGIC_REVIEW_SYSTEM_PROMPT } from '../../src/modules/logic-review/lib/prompt';
import { runLogicReview } from '../../src/modules/logic-review/lib/run';
import { LogicIssue, LOGIC_REVIEW_SOURCE } from '../../src/modules/logic-review/lib/schema';
import { MAX_LOGIC_ISSUES, validateLogicIssues } from '../../src/modules/logic-review/lib/validate';
import { buildReviewView } from '../../src/modules/review/lib/review-view';

const DIFF = `diff --git a/lib/cart.js b/lib/cart.js
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/lib/cart.js
@@ -0,0 +1,12 @@
+function total(items) {
+    let sum = 0;
+    for (let i = 0; i <= items.length; i++) {
+        sum += items[i].price;
+    }
+    return sum;
+}
+
+function lookup(db, id) {
+    return db.query("SELECT * FROM carts WHERE id = " + id + " LIMIT 1");
+}
+module.exports = { total, lookup };
diff --git a/lib/old.js b/lib/old.js
index 2222222..3333333 100644
--- a/lib/old.js
+++ b/lib/old.js
@@ -10,5 +10,5 @@ function keep() {
     const a = 1;
-    const b = 2;
+    const b = 3;
     return a + b;
 }

diff --git a/package-lock.json b/package-lock.json
index 4444444..5555555 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0.0"
+  "version": "1.0.1"
 }
diff --git a/lib/gone.js b/lib/gone.js
deleted file mode 100644
index 6666666..0000000
--- a/lib/gone.js
+++ /dev/null
@@ -1,2 +0,0 @@
-const x = 1;
-module.exports = x;
`;

const issue = (over: Partial<LogicIssue> = {}): LogicIssue => ({
    filePath: 'lib/cart.js',
    startLine: 3,
    endLine: 3,
    quotedLine: 'for (let i = 0; i <= items.length; i++) {',
    title: 'Loop reads one element past the end of the array',
    explanation: 'With items = [a], i reaches 1 and items[1].price throws.',
    suggestion: 'Use i < items.length.',
    category: 'off-by-one',
    severity: 'HIGH',
    confidence: 'HIGH',
    ...over,
});

const files = parseDiffFiles(DIFF);
const reviewed = selectFilesForReview(files, 60000).reviewed;
const SQLI_TOOL_FINDING = { filePath: 'lib/cart.js', startLine: 10, endLine: 10, ruleId: 'prism-sql-injection', message: 'Potential SQL injection detected.' };

describe('logic review: reading the diff', () => {
    it('gives every new-side line its real line number and marks the added ones', () => {
        const cart = files.find(f => f.path === 'lib/cart.js')!;
        expect(cart.lines.get(3)).toBe('    for (let i = 0; i <= items.length; i++) {');
        expect(cart.added.size).toBe(12);

        const old = files.find(f => f.path === 'lib/old.js')!;
        expect(old.lines.get(10)).toBe('    const a = 1;');
        expect(old.lines.get(11)).toBe('    const b = 3;');
        expect(Array.from(old.added)).toEqual([11]);
        expect(old.lines.get(12)).toBe('    return a + b;');
    });

    it('ignores deleted files and reviews only source code', () => {
        expect(files.map(f => f.path)).not.toContain('lib/gone.js');
        expect(isReviewableFile('package-lock.json')).toBe(false);
        expect(isReviewableFile('dist/app.js')).toBe(false);
        expect(isReviewableFile('src/app.min.js')).toBe(false);
        expect(isReviewableFile('README.md')).toBe(false);
        expect(isReviewableFile('src/pages/index.tsx')).toBe(true);
        expect(reviewed.map(f => f.path)).toEqual(['lib/cart.js', 'lib/old.js']);
    });

    it('shows the model line numbers and which lines changed', () => {
        const rendered = renderDiffFile(files.find(f => f.path === 'lib/old.js')!);
        expect(rendered).toContain('### lib/old.js');
        expect(rendered).toContain('     10 |     const a = 1;');
        expect(rendered).toContain('+    11 |     const b = 3;');
    });

    it('never cuts a file in half: a file over budget is left out whole and reported', () => {
        const cartOnly = selectFilesForReview(files, renderDiffFile(files[0]).length + 5);
        expect(cartOnly.reviewed.map(f => f.path)).toEqual(['lib/cart.js']);
        expect(cartOnly.overBudget).toEqual(['lib/old.js']);
        expect(cartOnly.rendered).not.toContain('lib/old.js');
    });
});

describe('logic review: which of the model\'s issues are kept', () => {
    it('keeps an issue tied to real changed code, with the snippet read from the diff', () => {
        const { accepted, discarded } = validateLogicIssues([issue()], reviewed, []);
        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatchObject({ filePath: 'lib/cart.js', startLine: 3, endLine: 3, severity: 'HIGH' });
        expect(accepted[0].codeSnippet).toBe('    for (let i = 0; i <= items.length; i++) {');
        expect(discarded).toEqual({});
    });

    it('drops an issue a scanner already reported on those lines', () => {
        const onSqlLine = issue({ startLine: 10, endLine: 10, quotedLine: 'return db.query("SELECT * FROM carts WHERE id = " + id + " LIMIT 1");', title: 'Query built by concatenation' });
        const { accepted, discarded } = validateLogicIssues([onSqlLine, issue()], reviewed, [SQLI_TOOL_FINDING]);
        expect(accepted.map(a => a.startLine)).toEqual([3]);
        expect(discarded['reported-by-tool']).toBe(1);
    });

    it('drops invented issues: unknown file, quote that is not in the code, unchanged lines', () => {
        const { accepted, discarded } = validateLogicIssues([
            issue({ filePath: 'lib/does-not-exist.js' }),
            issue({ quotedLine: 'while (queue.length > 0) {' }),
            issue({ filePath: 'lib/old.js', startLine: 10, endLine: 10, quotedLine: 'const a = 1;' }),
            issue({ startLine: 0, endLine: 0 }),
            issue({ startLine: 1, endLine: 400 }),
        ], reviewed, []);
        expect(accepted).toHaveLength(0);
        expect(discarded).toEqual({ 'unknown-file': 1, 'quote-mismatch': 1, 'not-on-changed-lines': 1, 'invalid-lines': 2 });
    });

    it('moves an issue to where the quoted code really is when the line number is slightly off', () => {
        const { accepted } = validateLogicIssues([issue({ startLine: 5, endLine: 5 })], reviewed, []);
        expect(accepted).toHaveLength(1);
        expect(accepted[0].startLine).toBe(3);
        expect(accepted[0].codeSnippet).toContain('i <= items.length');
    });

    it('drops low-confidence guesses and duplicates, and caps how many are shown', () => {
        const { accepted, discarded } = validateLogicIssues([issue({ confidence: 'LOW' }), issue(), issue({ title: 'Same line again' })], reviewed, []);
        expect(accepted).toHaveLength(1);
        expect(discarded).toMatchObject({ 'low-confidence': 1, duplicate: 1 });

        const lines = ['function total(items) {', 'let sum = 0;', 'for (let i = 0; i <= items.length; i++) {', 'sum += items[i].price;', 'return sum;', 'function lookup(db, id) {', 'module.exports = { total, lookup };'];
        const numbers = [1, 2, 3, 4, 6, 9, 12];
        const many = [...lines.map((quotedLine, i) => issue({ startLine: numbers[i], endLine: numbers[i], quotedLine })),
            issue({ filePath: 'lib/old.js', startLine: 11, endLine: 11, quotedLine: 'const b = 3;' }),
            issue({ startLine: 10, endLine: 10, quotedLine: 'return db.query("SELECT * FROM carts WHERE id = " + id + " LIMIT 1");' })];
        const capped = validateLogicIssues(many, reviewed, []);
        expect(capped.accepted).toHaveLength(MAX_LOGIC_ISSUES);
        expect(capped.discarded['over-limit']).toBe(1);
    });

    it('accepts the path with a leading a/ or b/ or ./', () => {
        expect(validateLogicIssues([issue({ filePath: 'b/lib/cart.js' })], reviewed, []).accepted).toHaveLength(1);
        expect(validateLogicIssues([issue({ filePath: './lib/cart.js' })], reviewed, []).accepted).toHaveLength(1);
    });
});

describe('logic review: the prompt', () => {
    it('tells the model what the scanners found and what is out of scope', () => {
        const prompt = buildLogicReviewPrompt({ title: 'Add cart', description: 'Adds totals', renderedDiff: 'DIFF', toolFindings: [SQLI_TOOL_FINDING] });
        expect(prompt).toContain('lib/cart.js:10 [prism-sql-injection] Potential SQL injection detected.');
        expect(LOGIC_REVIEW_SYSTEM_PROMPT).toMatch(/Do NOT report/);
        expect(LOGIC_REVIEW_SYSTEM_PROMPT).toMatch(/security vulnerability patterns/);
        expect(LOGIC_REVIEW_SYSTEM_PROMPT).toMatch(/untrusted input/);
        expect(buildLogicReviewPrompt({ title: 't', description: '', renderedDiff: 'D', toolFindings: [] })).toContain('(none)');
    });
});

describe('logic review: running it', () => {
    const input = { diff: DIFF, title: 'Add cart', description: '', toolFindings: [SQLI_TOOL_FINDING] };

    it('returns the validated issues and what was covered', async () => {
        const result = await runLogicReview(input, async ({ prompt }) => {
            expect(prompt).toContain('### lib/cart.js');
            expect(prompt).not.toContain('package-lock.json');
            return { issues: [issue(), issue({ startLine: 10, endLine: 10, quotedLine: 'return db.query("SELECT * FROM carts WHERE id = " + id + " LIMIT 1");' })] };
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.issues.map(i => i.startLine)).toEqual([3]);
        expect(result.discarded['reported-by-tool']).toBe(1);
        expect(result.coverage.reviewedFiles).toEqual(['lib/cart.js', 'lib/old.js']);
        expect(result.model).toBe('test-model');
    });

    it('a model failure is a failed review, never "no issues", and never throws', async () => {
        const result = await runLogicReview(input, async () => { throw new Error('Rate limit reached'); });
        expect(result).toMatchObject({ ok: false, code: 'LOGIC_REVIEW_MODEL_FAILED' });
        if (result.ok) return;
        expect(result.error).toContain('Rate limit');
    });

    it('output in the wrong shape is a failed review', async () => {
        const result = await runLogicReview(input, async () => ({ issues: [{ filePath: 'lib/cart.js' }] }) as any);
        expect(result).toMatchObject({ ok: false, code: 'LOGIC_REVIEW_INVALID_OUTPUT' });
    });

    it('does not call the model when the diff has no source code', async () => {
        const generate = vi.fn();
        const lockOnly = DIFF.substring(DIFF.indexOf('diff --git a/package-lock.json'), DIFF.indexOf('diff --git a/lib/gone.js'));
        const result = await runLogicReview({ ...input, diff: lockOnly }, generate);
        expect(generate).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, issues: [] });
    });
});

describe('logic review on the review page', () => {
    const logicFinding = {
        id: 'logic-1', source: LOGIC_REVIEW_SOURCE, ruleId: 'logic/off-by-one', ruleName: 'Loop reads past the end', severity: 'HIGH',
        filePath: 'lib/cart.js', startLine: 3, endLine: 3, codeSnippet: 'for (...)', message: 'Throws on the last iteration.',
        metadata: { logicReview: { suggestion: 'Use <' } }, triageDecision: null, status: 'NO_AUTOFIX', fixes: [], classifications: [],
    };
    const toolScans = [
        { kind: 'HEAD', source: 'SEMGREP', status: 'COMPLETED', scannedFiles: 4 },
        { kind: 'BASE', source: 'SEMGREP', status: 'COMPLETED', scannedFiles: 2 },
    ];
    const run = (logicScan: any | null, findings: any[]) => ({
        id: 'run-1', status: 'COMPLETED', headSha: 'a'.repeat(40), repository: {},
        scanRuns: logicScan ? [...toolScans, { kind: 'HEAD', source: LOGIC_REVIEW_SOURCE, ...logicScan }] : toolScans,
        findings,
    });

    it('is absent when the review was not requested', () => {
        expect(buildReviewView(run(null, []), null).logicReview).toBeNull();
    });

    it('lists its suggestions as optional reading that changes nothing else on the page', () => {
        const view = buildReviewView(run({ status: 'COMPLETED', scannedFiles: 2, skippedFiles: 0 }, [logicFinding]), null);

        expect(view.logicReview).toMatchObject({ state: 'done', summary: 'The AI read the 2 changed code files and has 1 suggestion.' });
        expect(view.logicReview!.issues[0]).toMatchObject({ title: 'Loop reads past the end', location: 'lib/cart.js:3', suggestion: 'Use <' });
        expect(view.shown).toHaveLength(0);
        expect(view.steps.find(s => s.key === 'scan')!.detail).toBe('4 files scanned, 0 issues found');
        // A suggestion is not an issue: the result, the counts and the stages are those of a clean review.
        expect(view.headline).toMatchObject({ label: 'No issues found', tone: 'success' });
        expect(view.stats.map(s => s.key)).toEqual(['shown', 'waiting', 'applied', 'hidden']);
        expect(view.stats.every(s => s.value === 0)).toBe(true);
        expect(view.steps.map(s => s.key)).toEqual(['scan', 'result']);
        expect(view.logicReview!.issues[0]).not.toHaveProperty('myVerdict');
    });

    it('a clean logic review says how much it covered, including what it could not', () => {
        const view = buildReviewView(run({ status: 'COMPLETED', scannedFiles: 3, skippedFiles: 1 }, []), null);
        expect(view.logicReview!.summary).toBe('The AI read the 3 changed code files and has nothing to suggest. 1 large file could not be included and was not reviewed.');
        expect(view.headline.label).toBe('No issues found');
    });

    it('a failed logic review is shown as having no result, and does not fail the scan step', () => {
        const view = buildReviewView(run({ status: 'FAILED', toolErrors: { code: 'LOGIC_REVIEW_MODEL_FAILED' } }, []), null);
        expect(view.logicReview).toMatchObject({ state: 'failed', issues: [] });
        expect(view.logicReview!.summary).toMatch(/not the same as finding nothing/);
        expect(view.steps.find(s => s.key === 'scan')!.state).toBe('done');
    });

    it('a pull request with no source code says there was nothing to review', () => {
        const view = buildReviewView(run({ status: 'COMPLETED', scannedFiles: 0, skippedFiles: 0 }, []), null);
        expect(view.logicReview!.summary).toMatch(/changes no source code files/);
    });
});
