/**
 * ESLint as a second scanner. It has to behave like Semgrep everywhere after the scan:
 * fail closed, normalize into the common finding shape, and be triaged by its own model
 * against that model's own threshold.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateEslintScan } from '../../src/modules/scanners/eslint/scan-result';
import { eslintCategory, eslintSeverity, ruleFamily } from '../../src/modules/scanners/eslint/rules';
import { buildEslintFeatures, EslintFeatureContext } from '../../src/modules/scanners/eslint/features';
import { callEslintMLService, getEslintMLUrl } from '../../src/modules/scanners/eslint/classifier';
import { getFinalDecision, getScoreRoutingDecision } from '../../src/modules/triage/lib/policy';
import { getEnabledScanners, getScanner, ScannerConfigError } from '../../src/modules/scanners/registry';
import { isRescanCheck, scannerDisplayName, SCANNER_CATALOG } from '../../src/modules/scanners/catalog';
import { computeDelta } from '../../src/modules/validation/lib/delta';

const message = (over: Record<string, unknown> = {}) => ({
    ruleId: 'no-unused-vars', severity: 2, message: "'foo' is assigned a value but never used.",
    line: 25, column: 7, endLine: 25, endColumn: 10, fatal: false, fix: null, suggestionCount: 0,
    lines: '    const foo = compute();', ...over,
});
const file = (over: Record<string, unknown> = {}) => ({ filePath: 'src/lib/cart.js', fileSizeLines: 150, messages: [message()], ...over });
const callback = (results: unknown[] = [file()], over: Record<string, unknown> = {}) => ({
    status: 'COMPLETED', tool: 'ESLINT',
    toolResult: { tool: 'eslint', version: '9.17.0', results, scanned: (results as any[]).map(r => r.filePath), ...over },
});

describe('evaluateEslintScan: fail closed', () => {
    it('treats a missing callback as a timeout, never as a clean scan', () => {
        expect(evaluateEslintScan(null)).toMatchObject({ ok: false, code: 'SCAN_TIMEOUT', jobStatus: 'TIMEOUT' });
    });

    it('passes on the runner\'s failure code', () => {
        expect(evaluateEslintScan({ status: 'FAILED', errorCode: 'SCAN_NONZERO_EXIT', error: 'ESLint exited with code 2' }))
            .toMatchObject({ ok: false, code: 'SCAN_NONZERO_EXIT', jobStatus: 'FAILED' });
    });

    it('rejects a success without a result, and output that is not ESLint\'s', () => {
        expect(evaluateEslintScan({ status: 'COMPLETED' })).toMatchObject({ ok: false, code: 'SCAN_RESULT_MISSING' });
        // Semgrep-shaped output sent to the ESLint adapter
        expect(evaluateEslintScan({ status: 'COMPLETED', toolResult: { results: [], errors: [] } })).toMatchObject({ ok: false, code: 'SCAN_RESULT_INVALID' });
        expect(evaluateEslintScan(callback([file({ messages: [message({ severity: 3 })] })]))).toMatchObject({ ok: false, code: 'SCAN_RESULT_INVALID' });
        expect(evaluateEslintScan(callback([file({ messages: [message({ lines: undefined })] })]))).toMatchObject({ ok: false, code: 'SCAN_RESULT_INVALID' });
    });

    it('rejects a path that is not inside the repository', () => {
        for (const filePath of ['../outside.js', '/etc/passwd', 'C:/Windows/x.js', 'a/../../b.js']) {
            expect(evaluateEslintScan(callback([file({ filePath })]))).toMatchObject({ ok: false, code: 'SCAN_NON_CANONICAL_PATH' });
        }
    });

    it('a completed lint with nothing to report is a real clean result', () => {
        const result = evaluateEslintScan(callback([file({ messages: [] })]));
        expect(result).toMatchObject({ ok: true, findings: [], scannedFiles: 1, toolVersion: '9.17.0' });
    });

    it('accepts "nothing was lintable" as a completed scan of zero files', () => {
        expect(evaluateEslintScan(callback([], { version: null }))).toMatchObject({ ok: true, findings: [], scannedFiles: 0, toolVersion: null });
    });
});

describe('evaluateEslintScan: normalization', () => {
    it('turns a message into the common finding shape', () => {
        const result = evaluateEslintScan(callback());
        if (!result.ok) throw new Error('expected ok');
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
            ruleId: 'no-unused-vars', category: 'MAINTAINABILITY', severity: 'MEDIUM', sourceSeverity: 'error',
            message: "'foo' is assigned a value but never used.", filePath: 'src/lib/cart.js',
            startLine: 25, endLine: 25, startCol: 7, endCol: 10, codeSnippet: '    const foo = compute();',
        });
        expect(result.findings[0].metadata).toEqual({ eslint: { severity: 2, ruleFamily: 'variables', hasFix: false, fixTextLength: 0, fixRangeLength: 0, suggestionCount: 0, fileSizeLines: 150 } });
        expect(result.findings[0].fingerprint).toMatch(/^[0-9a-f]{16,}$/);
    });

    it('records what ESLint offers as an automatic fix', () => {
        const result = evaluateEslintScan(callback([file({ messages: [message({ ruleId: 'prefer-const', fix: { range: [25, 35], text: 'const y = 2;' }, suggestionCount: 2 })] })]));
        if (!result.ok) throw new Error('expected ok');
        expect((result.findings[0].metadata as any).eslint).toMatchObject({ hasFix: true, fixTextLength: 12, fixRangeLength: 10, suggestionCount: 2 });
    });

    it('keeps two rules on the same line apart, and the same rule on identical lines countable', () => {
        const result = evaluateEslintScan(callback([file({ messages: [
            message({ ruleId: 'no-cond-assign', lines: 'if (a = 2) {' }),
            message({ ruleId: 'no-constant-condition', lines: 'if (a = 2) {' }),
            message({ ruleId: 'no-cond-assign', lines: 'if (a = 2) {', line: 40, endLine: 40 }),
        ] })]));
        if (!result.ok) throw new Error('expected ok');
        const [a, b, c] = result.findings.map(f => f.fingerprint);
        expect(a).not.toBe(b);
        expect(a).toBe(c); // same rule, same text: the pipeline numbers them as occurrences 1 and 2
    });

    it('a file ESLint could not parse is a warning on the scan, not a finding and not a failed scan', () => {
        const broken = file({ filePath: 'src/broken.js', messages: [message({ ruleId: null, fatal: true, message: 'Parsing error: Unexpected token (', lines: 'function ( {' })] });
        const result = evaluateEslintScan(callback([file(), broken]));
        if (!result.ok) throw new Error('expected ok');
        expect(result.findings).toHaveLength(1);
        expect(result.toolWarnings).toEqual([{ level: 'warn', type: 'ParseError', path: 'src/broken.js', line: 25, message: 'Parsing error: Unexpected token (' }]);
    });

    it('maps warnings to low severity', () => {
        const result = evaluateEslintScan(callback([file({ messages: [message({ severity: 1 })] })]));
        if (!result.ok) throw new Error('expected ok');
        expect(result.findings[0]).toMatchObject({ severity: 'LOW', sourceSeverity: 'warning' });
    });
});

describe('rule families and categories', () => {
    it('uses the rule groups the model was trained on', () => {
        expect(ruleFamily('no-unused-vars')).toBe('variables');
        expect(ruleFamily('no-undef')).toBe('variables');
        expect(ruleFamily('no-cond-assign')).toBe('possible-errors');
        expect(ruleFamily('no-fallthrough')).toBe('best-practices');
        expect(ruleFamily('prefer-const')).toBe('es6');
        expect(ruleFamily('@typescript-eslint/no-unused-vars')).toBe('variables');
        expect(ruleFamily('@typescript-eslint/no-explicit-any')).toBe('typescript');
        expect(ruleFamily('some-plugin/unknown-rule')).toBe('other');
    });

    it('separates wrong code from untidy code', () => {
        expect(eslintCategory('no-undef')).toBe('CORRECTNESS');
        expect(eslintCategory('no-cond-assign')).toBe('CORRECTNESS');
        expect(eslintCategory('no-unused-vars')).toBe('MAINTAINABILITY');
        expect(eslintCategory('@typescript-eslint/no-explicit-any')).toBe('MAINTAINABILITY');
        expect(eslintCategory('prefer-const')).toBe('STYLE');
        expect(eslintCategory('unknown-rule')).toBe('BEST_PRACTICE');
    });

    it('never rates a lint finding high', () => {
        expect(eslintSeverity(2)).toBe('MEDIUM');
        expect(eslintSeverity(1)).toBe('LOW');
    });
});

describe('model features', () => {
    const stored = (over: Record<string, unknown> = {}) => ({
        id: 'f1', ruleId: 'no-unused-vars', message: "'foo' is assigned a value but never used.", filePath: 'src/lib/cart.js',
        startLine: 25, endLine: 25, startCol: 7, endCol: 10,
        metadata: { eslint: { severity: 1, ruleFamily: 'variables', hasFix: false, fixTextLength: 0, fixRangeLength: 0, suggestionCount: 0, fileSizeLines: 150 } },
        ...over,
    });
    const ctx = (over: Partial<EslintFeatureContext> = {}): EslintFeatureContext => ({
        fileHunks: new Map([['src/lib/cart.js', [{ start: 20, end: 30 }]]]),
        totalChangedLines: 11,
        headFindings: [
            { id: 'f0', ruleId: 'no-undef', filePath: 'src/lib/cart.js', startLine: 22, startCol: 3 },
            { id: 'f1', ruleId: 'no-unused-vars', filePath: 'src/lib/cart.js', startLine: 25, startCol: 7 },
            { id: 'f2', ruleId: 'no-unused-vars', filePath: 'src/other.js', startLine: 4, startCol: 1 },
            { id: 'f3', ruleId: 'no-unused-vars', filePath: 'src/third.js', startLine: 9, startCol: 1 },
        ],
        baseFindings: [
            { ruleId: 'no-unused-vars', filePath: 'src/lib/cart.js' },
            { ruleId: 'no-empty', filePath: 'src/lib/cart.js' },
            { ruleId: 'no-unused-vars', filePath: 'src/other.js' },
        ],
        ...over,
    });

    it('builds every field of the model request (values follow the reference example; length and word count are measured from the real message)', () => {
        expect(buildEslintFeatures(stored(), ctx())).toEqual({
            message: "'foo' is assigned a value but never used.", rule_id: 'no-unused-vars', rule_family: 'variables',
            severity_text: 'warning', language: 'javascript', path_extension: '.js',
            severity: 1, is_error: 0, is_warning: 1,
            message_length: 41, message_word_count: 8,
            start_line: 25, start_column: 7, end_line: 25, end_column: 10,
            finding_span_lines: 1, finding_span_columns: 3,
            has_fix: 0, fix_text_length: 0, fix_range_length: 0, has_suggestions: 0, suggestion_count: 0,
            changed_line_start: 20, changed_line_end: 30, changed_line_count: 11,
            finding_overlaps_change: 1, finding_change_distance: 0,
            file_size_lines: 150, finding_start_line_ratio: 0.167,
            pr_change_code_lines: 11,
            base_file_finding_count: 2, base_rule_finding_count: 1, base_file_has_findings: 1, base_rule_exists_in_file: 1,
            prior_findings_in_file: 1, pr_total_findings_in_file: 2,
            same_rule_findings_in_file: 1, same_rule_findings_in_repo: 3,
            path_depth: 2, path_has_test: 0, path_has_src: 1, path_has_config: 0, path_has_generated: 0,
        });
    });

    it('measures the distance to the nearest change when the finding is outside every changed range', () => {
        const f = buildEslintFeatures(stored({ startLine: 60, endLine: 61 }), ctx({ fileHunks: new Map([['src/lib/cart.js', [{ start: 1, end: 5 }, { start: 40, end: 50 }]]]) }))!;
        expect(f).toMatchObject({ changed_line_start: 40, changed_line_end: 50, changed_line_count: 11, finding_overlaps_change: 0, finding_change_distance: 10, finding_span_lines: 2 });
    });

    it('says "no change known" with nulls, not with zeros that would read as "on a changed line"', () => {
        const f = buildEslintFeatures(stored(), ctx({ fileHunks: new Map() }))!;
        expect(f).toMatchObject({ changed_line_start: null, changed_line_end: null, changed_line_count: null, finding_overlaps_change: 0, finding_change_distance: null });
    });

    it('recognises typescript, tests and config paths', () => {
        const f = buildEslintFeatures(stored({ filePath: 'packages/app/__tests__/cart.config.test.tsx' }), ctx())!;
        expect(f).toMatchObject({ language: 'typescript', path_extension: '.tsx', path_depth: 3, path_has_test: 1, path_has_config: 1, path_has_src: 0 });
    });

    it('returns null instead of inventing inputs for a finding without ESLint measurements', () => {
        expect(buildEslintFeatures(stored({ metadata: null }), ctx())).toBeNull();
        expect(buildEslintFeatures(stored({ metadata: { eslint: { severity: 2 } } }), ctx())).toBeNull();
        expect(buildEslintFeatures(stored({ filePath: 'scripts/tool.py' }), ctx())).toBeNull();
    });
});

describe('ESLint model client', () => {
    const features = { rule_id: 'no-unused-vars' } as any;
    const prediction = (p: number, threshold = 0.505) => ({ probabilities: { logistic_regression: p, random_forest: p, xgboost: p }, ensemble_surface_probability: p, threshold, decision: p >= threshold ? 'surface' : 'suppress' });
    const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ findingId: `f${i}`, features }));

    afterEach(() => { vi.unstubAllEnvs(); });

    it('returns one prediction per finding, matched by position', async () => {
        vi.stubEnv('ESLINT_ML_SERVICE_URL', 'https://model.example/');
        const fetchImpl = respond({ predictions: [prediction(0.56), prediction(0.2)] });
        const results = await callEslintMLService(items(2), fetchImpl);
        expect(results.map(r => r.ok && [r.findingId, r.prediction.decision, r.prediction.ensemble_surface_probability])).toEqual([['f0', 'surface', 0.56], ['f1', 'suppress', 0.2]]);
        expect((fetchImpl as any).mock.calls[0][0]).toBe('https://model.example/predict/batch');
        expect(JSON.parse((fetchImpl as any).mock.calls[0][1].body)).toEqual({ findings: [features, features] });
    });

    it('splits more than 100 findings into several requests', async () => {
        vi.stubEnv('ESLINT_ML_SERVICE_URL', 'https://model.example');
        const fetchImpl = vi.fn(async (_url: any, init: any) => new Response(JSON.stringify({ predictions: JSON.parse(init.body).findings.map(() => prediction(0.9)) }))) as unknown as typeof fetch;
        const results = await callEslintMLService(items(230), fetchImpl);
        expect((fetchImpl as any).mock.calls.map((c: any) => JSON.parse(c[1].body).findings.length)).toEqual([100, 100, 30]);
        expect(results).toHaveLength(230);
        expect(results.every(r => r.ok)).toBe(true);
        expect(results.map(r => r.findingId)).toEqual(items(230).map(i => i.findingId));
    });

    it('never guesses: a wrong count, a self-contradicting answer, a bad shape and an HTTP error all become explicit errors', async () => {
        vi.stubEnv('ESLINT_ML_SERVICE_URL', 'https://model.example');
        const cases: Array<[typeof fetch, RegExp]> = [
            [respond({ predictions: [prediction(0.9)] }), /1 predictions for 2 findings/],
            [respond({ predictions: [{ ...prediction(0.9), decision: 'suppress' }, prediction(0.1)] }), /does not match its own score/],
            [respond({ predictions: [{ ...prediction(0.9), ensemble_surface_probability: 1.7 }, prediction(0.1)] }), /not in the expected shape/],
            [respond({ nope: true }), /not in the expected shape/],
            [respond({ detail: 'boom' }, 503), /HTTP error 503/],
            [vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as unknown as typeof fetch, /timed out/],
        ];
        for (const [fetchImpl, reason] of cases) {
            const results = await callEslintMLService(items(2), fetchImpl);
            expect(results).toHaveLength(2);
            for (const r of results) {
                expect(r.ok).toBe(false);
                if (!r.ok) expect(r.error).toMatch(reason);
            }
        }
    });

    it('reports a missing or invalid endpoint as an error per finding, without calling anything', async () => {
        const fetchImpl = respond({});
        for (const value of ['', '   ', 'not a url', 'ftp://model.example']) {
            vi.stubEnv('ESLINT_ML_SERVICE_URL', value);
            expect(getEslintMLUrl()).toBeNull();
            const results = await callEslintMLService(items(1), fetchImpl);
            expect(results[0]).toEqual({ findingId: 'f0', ok: false, error: 'ESLINT_ML_SERVICE_URL is not configured' });
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('makes no request for nothing', async () => {
        vi.stubEnv('ESLINT_ML_SERVICE_URL', 'https://model.example');
        const fetchImpl = respond({});
        expect(await callEslintMLService([], fetchImpl)).toEqual([]);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('each model is measured against its own threshold', () => {
    const finding = (over: Record<string, unknown> = {}) => ({ severity: 'MEDIUM', category: 'MAINTAINABILITY', inChangedLines: true, isPreexisting: false, ...over }) as any;
    const eslintBar = { showFrom: 0.505, hideBelow: 0.505 };

    it('a single-threshold model has no middle band', () => {
        expect(getScoreRoutingDecision(0.5633, eslintBar)).toBe('SURFACE');
        expect(getScoreRoutingDecision(0.505, eslintBar)).toBe('SURFACE');
        expect(getScoreRoutingDecision(0.5049, eslintBar)).toBe('SUPPRESS');
        expect(getScoreRoutingDecision(0.1, eslintBar)).toBe('SUPPRESS');
    });

    it('the same score routes differently under the two models\' bars', () => {
        // 0.5633 clears ESLint's 0.505 but not the Semgrep model's 0.60
        expect(getFinalDecision(finding(), 'model', 0.5633, eslintBar)).toEqual({ finalDecision: 'SURFACE', decisionSource: 'MODEL' });
        expect(getFinalDecision(finding(), 'model', 0.5633)).toEqual({ finalDecision: 'UNCERTAIN', decisionSource: 'MODEL' });
    });

    it('falls back to the standard rules when the model gave no score', () => {
        expect(getFinalDecision(finding({ category: 'CORRECTNESS' }), 'model', undefined, eslintBar)).toEqual({ finalDecision: 'SURFACE', decisionSource: 'POLICY_FALLBACK' });
        expect(getFinalDecision(finding(), 'model', undefined, eslintBar)).toEqual({ finalDecision: 'SUPPRESS', decisionSource: 'POLICY_FALLBACK' });
    });
});

describe('ESLint is a registered scanner like Semgrep', () => {
    it('is in the catalog with its own re-scan check', () => {
        expect(SCANNER_CATALOG.ESLINT).toEqual({ displayName: 'ESLint', rescanCheck: 'ESLINT_RESCAN' });
        expect(scannerDisplayName('ESLINT')).toBe('ESLint');
        expect(isRescanCheck('ESLINT_RESCAN')).toBe(true);
    });

    it('has an adapter with everything the pipeline calls', () => {
        const scanner = getScanner('ESLINT');
        expect(scanner.id).toBe('ESLINT');
        expect(scanner.rescanCheck).toBe('ESLINT_RESCAN');
        expect(scanner.getRulesetId()).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(typeof scanner.scoreFindings).toBe('function');
        expect(scanner.evaluateScan(null)).toMatchObject({ ok: false });
    });

    it('runs next to Semgrep when both are listed, and an unknown name is still an error', () => {
        expect(getEnabledScanners('SEMGREP,ESLINT').map(s => s.id)).toEqual(['SEMGREP', 'ESLINT']);
        expect(getEnabledScanners(' eslint ').map(s => s.id)).toEqual(['ESLINT']);
        expect(getEnabledScanners(undefined).map(s => s.id)).toEqual(['SEMGREP']);
        expect(() => getEnabledScanners('SEMGREP,ESLNT')).toThrow(ScannerConfigError);
    });

    it('a fix is judged by a re-scan the same way as for Semgrep', () => {
        const head = evaluateEslintScan(callback([file({ messages: [message(), message({ ruleId: 'no-undef', lines: 'return total;', line: 30, endLine: 30 })] })]));
        const fixed = evaluateEslintScan(callback([file({ messages: [message({ ruleId: 'no-undef', lines: 'return total;', line: 29, endLine: 29 })] })]));
        const worse = evaluateEslintScan(callback([file({ messages: [message(), message({ ruleId: 'no-undef', lines: 'return total;' }), message({ ruleId: 'no-empty', lines: '} catch (e) {}' })] })]));
        if (!head.ok || !fixed.ok || !worse.ok) throw new Error('expected ok');
        const target = head.findings[0];

        const good = computeDelta(target, head.findings, fixed.findings);
        expect(good.stats).toMatchObject({ targetFindingStatus: 'REMOVED', newFindingsCount: 0 });

        const bad = computeDelta(target, head.findings, worse.findings);
        expect(bad.stats).toMatchObject({ targetFindingStatus: 'UNCHANGED', newFindingsCount: 1 });
        expect(bad.deltas.find(d => d.delta === 'ADDED')).toMatchObject({ ruleId: 'no-empty' });
    });
});
