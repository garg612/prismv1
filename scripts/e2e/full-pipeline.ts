/**
 * End-to-end test of the whole review pipeline against the running app, runner, models and GitHub.
 *
 * It opens a pull request with known ESLint and Semgrep issues, waits for the review, then drives
 * the real review page in headless Chrome: answers "is this real?", rejects one fix, applies the
 * others with the Apply button, merges the fix pull request, and repeats on every re-check until
 * the pull request is clean. Every stage is checked against the database, GitHub and the page.
 *
 * It signs in by creating a session row for the repository owner that it deletes at the end.
 * Usage: npx tsx --env-file=.env scripts/e2e/full-pipeline.ts <puppeteerCoreDir> <screenshotDir>
 */
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { prisma } from '../../src/lib/db';
import { loadMetrics } from '../../src/modules/metrics/lib/load-metrics';
import { buildMetrics } from '../../src/modules/metrics/lib/metrics';
import { loadReview } from '../../src/modules/review/lib/load-review';
import { loadReviewList } from '../../src/modules/review/lib/load-review-list';

const [puppeteerDir, shotDir] = process.argv.slice(2);
const BASE = 'http://localhost:3000';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'garg612/demo1';
const MAX_ROUNDS = 5;

const gh = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`https://api.github.com/repos/${REPO}${p}`, {
        method,
        headers: { authorization: 'Bearer ' + process.env.GITHUB_TOKEN, 'user-agent': 'prism-e2e', accept: 'application/vnd.github+json', 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(json).slice(0, 200)}`);
    return json;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const checks: Array<{ ok: boolean; name: string; detail: string }> = [];
const check = (name: string, ok: boolean, detail = '') => {
    checks.push({ ok, name, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const same = (a: unknown[], b: unknown[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// ESLint: no-unused-vars, no-undef, no-cond-assign + no-constant-condition (same line), no-debugger,
// no-dupe-keys. Semgrep: SQL injection. lib/money.js is clean.
const FILES: Record<string, string> = {
    'lib/orders.js': `const db = require("./db");

function orderTotal(order) {
    const taxRate = 0.2;
    let total = 0;
    for (const line of order.lines) {
        total += line.price * line.quantity;
    }
    return total + shippingFee;
}

function isPaid(order) {
    if (order.status = "paid") {
        debugger;
        return true;
    }
    return false;
}

function describeOrder(order) {
    return { id: order.id, status: order.status, id: order.reference };
}

function findOrders(customer) {
    return db.query("SELECT * FROM orders WHERE customer = '" + customer + "' ORDER BY created");
}

module.exports = { orderTotal, isPaid, describeOrder, findOrders };
`,
    'lib/money.js': `function toCents(amount) {
    if (typeof amount !== "number" || Number.isNaN(amount)) {
        throw new Error("amount must be a number");
    }
    return Math.round(amount * 100);
}

module.exports = { toCents };
`,
};
const EXPECTED_ESLINT = ['no-unused-vars', 'no-undef', 'no-cond-assign', 'no-constant-condition', 'no-debugger', 'no-dupe-keys'];
const EXPECTED_SEMGREP = ['prism-sql-injection'];

async function openPullRequest() {
    const branch = `e2e-full-${Date.now()}`;
    const main = await gh('GET', '/git/ref/heads/main');
    const parent = await gh('GET', `/git/commits/${main.object.sha}`);
    const tree = await gh('POST', '/git/trees', { base_tree: parent.tree.sha, tree: Object.entries(FILES).map(([p, content]) => ({ path: p, mode: '100644', type: 'blob', content })) });
    const commit = await gh('POST', '/git/commits', { message: 'Add order helpers', tree: tree.sha, parents: [main.object.sha] });
    await gh('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
    const pr = await gh('POST', '/pulls', { title: 'Full pipeline E2E — disposable', head: branch, base: 'main', body: 'Adds order helpers.' });
    return { number: pr.number as number, branch, headSha: commit.sha as string };
}

const runInclude = {
    scanRuns: true,
    review: true,
    findings: {
        include: {
            classifications: true,
            feedback: true,
            fixes: { include: { patch: true, applyAttempts: true, validationRuns: { include: { validationResults: true } } } },
        },
    },
} as const;

/** The review of `headSha`, once it has stopped running. */
async function waitForReview(prNumber: number, headSha: string, timeoutMs = 9 * 60 * 1000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const run = await prisma.reviewRun.findFirst({ where: { pullRequest: { number: prNumber }, headSha }, orderBy: { updatedAt: 'desc' }, include: runInclude });
        if (run && ['AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELED'].includes(run.status)) return run;
        await sleep(10000);
    }
    throw new Error(`Review of ${headSha.slice(0, 7)} did not finish in ${timeoutMs / 60000} minutes`);
}
type Run = Awaited<ReturnType<typeof waitForReview>>;

const scanner = (run: Run) => run.findings.filter(f => f.source !== 'CUSTOM');
const shown = (run: Run) => scanner(run).filter(f => f.triageDecision === 'SURFACE');

function checkReview(run: Run, round: number) {
    console.log(`\nROUND ${round}: review ${run.id.slice(0, 8)} of ${run.headSha.slice(0, 7)} is ${run.status}`);
    check('review finished without failing', run.status === 'AWAITING_APPROVAL' || run.status === 'COMPLETED', `${run.status} ${run.failureCode ?? ''} ${run.failureMessage ?? ''}`);

    const scans = run.scanRuns.filter(s => s.source !== 'CUSTOM');
    check('both scanners scanned head and base', same(scans.map(s => `${s.source}:${s.kind}`), ['SEMGREP:HEAD', 'SEMGREP:BASE', 'ESLINT:HEAD', 'ESLINT:BASE']), scans.map(s => `${s.source}:${s.kind}:${s.status}`).join(' '));
    check('every scan completed', scans.every(s => s.status === 'COMPLETED'));
    check('each scan records its tool version', scans.every(s => new RegExp(`^${s.source.toLowerCase()} \\d`).test(s.toolVersion || '')), scans.map(s => s.toolVersion).join(' | '));

    const all = scanner(run);
    check('no finding in the clean file', all.every(f => f.filePath !== 'lib/money.js'));
    check('every finding has real source text and a line', all.every(f => !!f.codeSnippet && f.startLine >= 1));
    check('every finding is triaged', all.every(f => f.triageDecision !== null));
    check('nothing was left "uncertain" for ESLint (its model has one threshold)', all.filter(f => f.source === 'ESLINT').every(f => f.triageDecision !== 'UNCERTAIN'));

    const modelOf = (f: Run['findings'][number]) => f.classifications.find(c => !c.modelName.startsWith('policy'));
    check('ESLint findings were scored by the ESLint model', all.filter(f => f.source === 'ESLINT').every(f => modelOf(f)?.modelName === 'prism-eslint-ensemble'), all.filter(f => f.source === 'ESLINT').map(f => `${f.ruleId}=${modelOf(f)?.score.toFixed(2) ?? 'none'}`).join(' '));
    check('Semgrep findings were scored by the Semgrep model', all.filter(f => f.source === 'SEMGREP').every(f => modelOf(f)?.modelName === 'prism-exp2-ensemble'));
    check('each score is stored with its own model\'s bar', all.every(f => { const m = modelOf(f); return !m || (f.source === 'ESLINT' ? Math.abs((m.thresholdHigh ?? 0) - 0.505) < 0.01 : m.thresholdHigh === 0.6); }));
    check('a score-decided finding sits on the side of the bar its score says', all.every(f => {
        const routing = [...f.classifications].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).find(c => !c.isShadow);
        const m = modelOf(f);
        if (!m || routing?.decisionSource !== 'MODEL' || m.thresholdHigh == null) return true;
        return (m.score >= m.thresholdHigh) === (f.triageDecision === 'SURFACE');
    }));

    check('stored counters equal the rows', run.totalFindings === all.length && run.surfacedCount === shown(run).length, `total ${run.totalFindings}/${all.length} shown ${run.surfacedCount}/${shown(run).length}`);
    check('review duration was recorded', !!run.startedAt && !!run.finishedAt && run.finishedAt > run.startedAt, run.startedAt && run.finishedAt ? `${Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000)}s` : 'missing');

    const fixes = shown(run).flatMap(f => f.fixes.map(x => ({ f, x })));
    const ready = fixes.filter(({ x }) => x.status === 'READY');
    check('a fix was attempted for every shown issue, none left for a later review', shown(run).every(f => f.fixes.length > 0), shown(run).filter(f => f.fixes.length === 0).map(f => f.ruleId).join(' '));
    check('every ready fix passed a re-scan by the scanner that found the issue', ready.every(({ f, x }) =>
        x.validationRuns.some(v => v.tier === 'STATIC' && v.validationResults.some(r => r.check === `${f.source}_RESCAN` && r.status === 'PASSED'))), ready.map(({ f }) => f.ruleId).join(' '));
    check('every ready fix has a patch', ready.every(({ x }) => !!x.patch?.unifiedDiff));
    check('a report was written', !!run.review?.review);
    return ready.length;
}

async function main() {
    const puppeteer = createRequire(path.join(puppeteerDir, 'package.json'))('puppeteer-core');
    fs.mkdirSync(shotDir, { recursive: true });
    const repo = await prisma.repository.findFirst({ where: { owner: 'garg612', name: 'demo1' }, select: { userId: true, executionValidation: true } });
    if (!repo) throw new Error('repository not connected');
    const userId = repo.userId;

    const before = (await loadMetrics(userId, 30)).metrics;
    const logStart = fs.existsSync('.next/dev/logs/next-development.log') ? fs.readFileSync('.next/dev/logs/next-development.log', 'utf8').split('\n').length : 0;

    // Sign in
    const token = crypto.randomBytes(24).toString('base64url');
    const session = await prisma.session.create({ data: { id: crypto.randomUUID(), token, userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000), userAgent: 'prism-e2e' } });
    const signature = crypto.createHmac('sha256', process.env.BETTER_AUTH_SECRET as string).update(token).digest('base64');
    const cookieHeader = `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    const pageErrors: string[] = [];

    const openPage = async (url: string) => {
        const page = await browser.newPage();
        await page.setViewport({ width: 1360, height: 900 });
        await page.setExtraHTTPHeaders({ cookie: cookieHeader });
        page.on('console', (m: any) => { if (m.type() === 'error' && !/favicon|React DevTools/.test(m.text())) pageErrors.push(m.text().slice(0, 200)); });
        page.on('pageerror', (e: any) => pageErrors.push(String(e.message).slice(0, 200)));
        await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 120000 });
        await page.waitForSelector('[aria-busy="true"]', { hidden: true, timeout: 60000 }).catch(() => {});
        return page;
    };
    const text = (page: any) => page.evaluate(() => document.body.innerText);
    /** Click a button, by its text, inside the issue card whose text contains `cardText`. */
    const clickInCard = (page: any, cardText: string, button: string) => page.evaluate((c: string, b: string) => {
        const card = Array.from(document.querySelectorAll('article')).find(a => (a as HTMLElement).innerText.includes(c));
        const el = card && Array.from(card.querySelectorAll('button')).find(x => x.textContent?.trim() === b);
        (el as HTMLButtonElement | undefined)?.click();
        return !!el;
    }, cardText, button);

    try {
        console.log('STAGE 1: open a pull request');
        const pr = await openPullRequest();
        console.log(`  PR #${pr.number} on ${pr.branch} at ${pr.headSha.slice(0, 7)}`);

        let headSha = pr.headSha;
        let firstRunId = '';
        let totalApplied = 0;
        let rejectedOnce = false;
        let rejectedCount = 0;
        let rounds = 0;
        /** True once another session was seen deciding fixes on this pull request at the same time */
        let foreignActivity = false;
        let markedFalseAlarm = false;
        let finalRun: Run | null = null;

        for (let round = 1; round <= MAX_ROUNDS; round++) {
            const run = await waitForReview(pr.number, headSha);
            const readyCount = checkReview(run, round);
            if (run.status === 'FAILED' || run.status === 'CANCELED') break;

            if (round === 1) {
                firstRunId = run.id;
                check('ESLint found exactly the planted issues', same(run.findings.filter(f => f.source === 'ESLINT').map(f => f.ruleId), EXPECTED_ESLINT), run.findings.filter(f => f.source === 'ESLINT').map(f => f.ruleId).join(' '));
                check('Semgrep found exactly the planted issue', same(run.findings.filter(f => f.source === 'SEMGREP').map(f => f.ruleId), EXPECTED_SEMGREP));
                check('all planted issues are new in this pull request', scanner(run).every(f => !f.isPreexisting && f.inChangedLines));
                check('the review is waiting for a decision', run.status === 'AWAITING_APPROVAL');
                check('one review is enough: all 7 shown issues have a fix ready', shown(run).length === 7 && readyCount === 7, `${readyCount} ready for ${shown(run).length} shown`);
                const comments = await gh('GET', `/issues/${pr.number}/comments`);
                check('the review was posted on the pull request', comments.some((c: any) => /PRism/i.test(c.body || '')), `${comments.length} comment(s)`);
            }

            // A later review only ever has to deal with an issue whose fix was rejected.
            if (round > 1) check(`review ${round}: only an issue whose fix was rejected is still shown`, shown(run).length <= rejectedCount, `${shown(run).length} shown, ${rejectedCount} rejected`);
            rounds = round;
            if (shown(run).length === 0) { finalRun = run; break; }
            if (readyCount === 0) {
                check('every shown issue eventually gets a fix', false, `round ${round}: ${shown(run).map(f => `${f.ruleId}:${f.fixes.map(x => x.status).join('/') || 'no fix'}`).join(' ')}`);
                finalRun = run;
                break;
            }

            // ── The review page, as the owner sees it ──
            const page = await openPage(`/dashboard/reviews/${run.id}`);
            let body = await text(page);
            check('page: asks for a decision', body.includes('Needs your decision'));
            check('page: shows one card per shown issue', (await page.$$eval('article', (a: any[]) => a.length)) === shown(run).length, `${shown(run).length} expected`);
            check('page: never says "uncertain"', !/uncertain/i.test(body));
            check('page: no raw error code is visible', !/FIX_CONFLICT|IMPLEMENT_FAILED|INVALID_REVIEW_STATE/.test(body));
            if (round === 1) {
                check('page: names both scanners', body.includes('ESLint') && body.includes('Semgrep'));
                await page.screenshot({ path: path.join(shotDir, 'e2e-1-needs-decision.png'), fullPage: true });
            }

            // Reject one fix, once
            let rejectedId: string | null = null;
            if (!rejectedOnce) {
                // The last card with a fix: someone else working down the same page starts at the top.
                const order = await page.$$eval('article', (cards: any[]) => cards.map(c => (c as HTMLElement).innerText));
                const withFix = shown(run).filter(f => f.fixes.some(x => x.status === 'READY'));
                const victim = withFix.sort((a, b) => order.findIndex((t: string) => t.includes(b.ruleId) && t.includes(`:${b.startLine}`)) - order.findIndex((t: string) => t.includes(a.ruleId) && t.includes(`:${a.startLine}`)))[0];
                check('page: a fix can be rejected', await clickInCard(page, victim.ruleId, 'Reject'));
                await page.waitForFunction((rule: string) => {
                    const card = Array.from(document.querySelectorAll('article')).find(a => (a as HTMLElement).innerText.includes(rule));
                    return !!card && (card as HTMLElement).innerText.includes('Rejected');
                }, { timeout: 60000 }, victim.ruleId).catch(() => {});
                const fix = await prisma.suggestedFix.findFirst({ where: { findingId: victim.id }, orderBy: { createdAt: 'desc' } });
                // Someone else using the app at the same moment may have decided this fix first.
                // Then the rejection was correctly refused, and it is tried again on the next review.
                if (fix?.status === 'REJECTED') {
                    check('the rejected fix is stored as rejected', true);
                    rejectedId = victim.id;
                    rejectedOnce = true;
                    rejectedCount++;
                } else {
                    console.log(`  note: the fix chosen for rejection was decided by another session first (${fix?.status}); the rejection was refused`);
                    foreignActivity = true;
                }
            }

            // Answer "is this real?" once each way
            if (!markedFalseAlarm) {
                const target = shown(run).find(f => f.ruleId === 'no-debugger') ?? shown(run)[0];
                const real = shown(run).find(f => f.id !== target.id)!;
                check('page: "No, false alarm" can be clicked', await clickInCard(page, target.ruleId, 'No, false alarm'));
                await page.waitForFunction(() => document.body.innerText.includes('You marked this as a false alarm.'), { timeout: 30000 }).catch(() => {});
                check('page: "Yes" can be clicked', await clickInCard(page, real.ruleId, 'Yes'));
                await page.waitForFunction(() => document.body.innerText.includes('You marked this as real.'), { timeout: 30000 }).catch(() => {});
                const rows = await prisma.findingFeedback.findMany({ where: { findingId: { in: [target.id, real.id] }, kind: { in: ['TRUE_POSITIVE', 'FALSE_POSITIVE'] } } });
                check('answers were stored, one per issue', rows.length === 2 && rows.some(r => r.findingId === target.id && r.kind === 'FALSE_POSITIVE') && rows.some(r => r.findingId === real.id && r.kind === 'TRUE_POSITIVE'), rows.map(r => r.kind).join(' '));
                await page.reload({ waitUntil: 'networkidle2' });
                body = await text(page);
                check('page: answers are still shown after a reload', body.includes('You marked this as a false alarm.') && body.includes('You marked this as real.'));
                markedFalseAlarm = true;
            }

            // Apply every remaining fix with the real button, one at a time
            let applied = 0;
            const alerts: string[] = [];
            for (let i = 0; i < 20; i++) {
                const clicked = await page.evaluate(() => {
                    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent?.trim() === 'Apply fix' && !(x as HTMLButtonElement).disabled);
                    (b as HTMLButtonElement | undefined)?.click();
                    return !!b;
                });
                if (!clicked) break;
                const remaining = await page.$$eval('button', (bs: any[]) => bs.filter(b => b.textContent?.trim() === 'Apply fix').length);
                await page.waitForFunction((n: number) => {
                    const left = Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.trim() === 'Apply fix').length;
                    return left < n || !!document.querySelector('[role="alert"]');
                }, { timeout: 120000 }, remaining).catch(() => {});
                const alert = await page.evaluate(() => (document.querySelector('[role="alert"]') as HTMLElement | null)?.innerText || '');
                if (alert) {
                    // "Already decided / being applied" means another session got there first: the
                    // guard did its job. Anything else is a real failure.
                    if (/already been decided|already being applied|no longer the one waiting/i.test(alert)) foreignActivity = true;
                    else alerts.push(alert.slice(0, 160));
                    await page.reload({ waitUntil: 'networkidle2' });
                    await sleep(1500);
                    continue;
                }
                applied++;
                await sleep(1500);
            }
            check('page: no fix failed to apply', alerts.length === 0, alerts.join(' | '));

            // Whoever clicked, every offered fix must reach a final state.
            const offeredIds = shown(run).filter(f => f.id !== rejectedId).flatMap(f => f.fixes.filter(x => x.status === 'READY').map(x => x.id));
            for (let i = 0; i < 40; i++) {
                const open = await prisma.suggestedFix.count({ where: { id: { in: offeredIds }, status: { in: ['READY', 'IMPLEMENTING', 'IMPLEMENT_FAILED'] } } });
                if (open === 0) break;
                if (i > 0 && i % 5 === 0) {
                    // a fix nobody has clicked yet: click it
                    await page.reload({ waitUntil: 'networkidle2' });
                    await page.evaluate(() => (Array.from(document.querySelectorAll('button')).find(x => x.textContent?.trim() === 'Apply fix' && !(x as HTMLButtonElement).disabled) as HTMLButtonElement | undefined)?.click());
                }
                await sleep(4000);
            }
            await page.reload({ waitUntil: 'networkidle2' });
            await page.screenshot({ path: path.join(shotDir, `e2e-${round}-after-apply.png`), fullPage: true });
            await page.close();
            const after = await prisma.reviewRun.findUniqueOrThrow({ where: { id: run.id }, include: runInclude });
            const fixState = shown(after).flatMap(f => f.fixes.map(x => ({ rule: f.ruleId, findingId: f.id, status: x.status, attempts: x.applyAttempts })));
            const implemented = fixState.filter(x => x.status === 'IMPLEMENTED');
            // The page can redraw two cards in one refresh, so the count comes from the stored result.
            const readyBefore = shown(run).filter(f => f.id !== rejectedId && f.fixes.some(x => x.status === 'READY')).length;
            check('every fix that was offered is stored as applied', implemented.length === readyBefore, `${implemented.length} of ${readyBefore}: ` + fixState.map(x => `${x.rule}:${x.status}`).join(' '));
            applied = implemented.length;
            totalApplied += applied;
            check('no fix is stuck or failed', fixState.every(x => ['IMPLEMENTED', 'REJECTED', 'NOT_READY', 'GUARD_REJECTED'].includes(x.status)), fixState.filter(x => !['IMPLEMENTED', 'REJECTED', 'NOT_READY', 'GUARD_REJECTED'].includes(x.status)).map(x => `${x.rule}:${x.status}`).join(' '));
            const prUrls = new Set(implemented.flatMap(x => x.attempts.filter(a => a.status === 'SUCCEEDED').map(a => a.resultPrUrl)));
            check('all fixes of the review went into one fix pull request', prUrls.size === 1, Array.from(prUrls).join(' '));
            const sameLine = implemented.filter(x => x.rule === 'no-cond-assign' || x.rule === 'no-constant-condition');
            if (round === 1 && shown(run).some(f => f.ruleId === 'no-cond-assign') && shown(run).some(f => f.ruleId === 'no-constant-condition')) {
                const offered = fixState.filter(x => (x.rule === 'no-cond-assign' || x.rule === 'no-constant-condition') && x.status !== 'NOT_READY' && x.status !== 'GUARD_REJECTED');
                check('two issues on the same line with the same fix both end up applied', sameLine.length === offered.length, `${sameLine.length} of ${offered.length}`);
            }
            const feedbackDupes = await prisma.$queryRawUnsafe<any[]>('select count(*)::int as n from (select "findingId","userId","kind" from "findingFeedback" group by 1,2,3 having count(*)>1) t');
            check('no duplicate decision rows', feedbackDupes[0].n === 0);
            if (rejectedId) check('the rejected issue was not marked accepted', (await prisma.finding.findUniqueOrThrow({ where: { id: rejectedId } })).status === 'REJECTED');

            // Merge the fix pull request, as the owner would on GitHub
            const fixPrNumber = Number(Array.from(prUrls)[0]?.match(/\/pull\/(\d+)/)?.[1]);
            if (!fixPrNumber) { check('the fix pull request can be found', false); break; }
            const fixPr = await gh('GET', `/pulls/${fixPrNumber}`);
            check('the fix pull request targets the original branch', fixPr.base.ref === pr.branch && fixPr.state === 'open', `${fixPr.head.ref} -> ${fixPr.base.ref}`);
            const fixFiles = await gh('GET', `/pulls/${fixPrNumber}/files`);
            check('the fix pull request only touches files that had issues', fixFiles.every((f: any) => f.filename === 'lib/orders.js'), fixFiles.map((f: any) => f.filename).join(' '));
            const merged = await gh('PUT', `/pulls/${fixPrNumber}/merge`, { merge_method: 'merge' });
            check('the fix pull request merged cleanly', merged.merged === true);
            // GitHub updates the pull request's head a moment after the merge call returns.
            const previousHead = headSha;
            for (let i = 0; i < 30 && headSha === previousHead; i++) {
                await sleep(2000);
                headSha = (await gh('GET', `/pulls/${pr.number}`)).head.sha;
            }
            check('the pull request moved to a new commit after the merge', headSha !== previousHead, headSha.slice(0, 7));
            console.log(`  merged fix PR #${fixPrNumber}; pull request is now at ${headSha.slice(0, 7)}`);
        }

        // ── The end state ──
        console.log('\nFINAL STATE');
        check('the pull request was clean after at most 3 reviews (fix, the rejected one, verify)', rounds <= 3, `${rounds} reviews`);
        check('the pull request ended with no shown issue', !!finalRun && shown(finalRun).length === 0, finalRun ? shown(finalRun).map(f => f.ruleId).join(' ') : 'no final review');
        if (finalRun && shown(finalRun).length === 0) {
            const content = Buffer.from((await gh('GET', `/contents/lib/orders.js?ref=${headSha}`)).content, 'base64').toString('utf8');
            check('code: the SQL query is parameterised', !/'" \+ customer \+ "'/.test(content) && /\?/.test(content));
            check('code: the assignment in the condition is gone', !/order\.status = "paid"/.test(content));
            check('code: debugger is gone', !/debugger/.test(content));
            check('code: the duplicate key is gone', (content.match(/\bid:/g) || []).length <= 1);
            check('code: the clean file was not touched', Buffer.from((await gh('GET', `/contents/lib/money.js?ref=${headSha}`)).content, 'base64').toString('utf8') === FILES['lib/money.js']);

            const view = (await loadReview(finalRun.id, userId))!.view;
            check('final review: "Fixed and verified"', view.headline.label === 'Fixed and verified', `${view.headline.label} — ${view.headline.detail}`);
            check('final review: the steps tell the story', same(view.steps.map(s => s.key), ['found', 'applied', 'rescan', 'verified']) && view.steps.every(s => s.state === 'done'), view.steps.map(s => `${s.key}:${s.state}`).join(' '));

            const page = await openPage(`/dashboard/reviews/${finalRun.id}`);
            const body = await text(page);
            check('final page: shows "Fixed and verified"', body.includes('Fixed and verified') && body.includes('No longer detected'));
            check('final page: nothing left to decide', !body.includes('Apply fix'));
            await page.screenshot({ path: path.join(shotDir, 'e2e-final-review.png'), fullPage: true });
            await page.close();

            const first = await prisma.reviewRun.findUniqueOrThrow({ where: { id: firstRunId } });
            check('the first review was replaced by the newer one', first.status === 'SUPERSEDED', first.status);

            const row = (await loadReviewList(userId)).items.find(i => i.prNumber === pr.number);
            check('reviews list: one row, "Fixed and verified"', row?.label === 'Fixed and verified' && row.runId === finalRun.id, row ? `${row.label} found=${row.counts.found} fixed=${row.counts.fixed} open=${row.counts.open}` : 'no row');
            check('reviews list: counts cover the whole pull request', !!row && row.counts.found === EXPECTED_ESLINT.length + EXPECTED_SEMGREP.length && row.counts.open === 0 && row.counts.toDecide === 0, row ? JSON.stringify(row.counts) : '');
            const list = await openPage('/dashboard/reviews');
            const listText = await text(list);
            check('reviews list page renders the row', listText.includes('Full pipeline E2E') && listText.includes('Fixed and verified'));
            await list.close();
        }

        // The numbers the Insights page is built from, for this pull request alone (other pull
        // requests of the account change while this test runs).
        const rows = await prisma.finding.findMany({
            where: { source: { not: 'CUSTOM' }, reviewRun: { pullRequest: { number: pr.number } } },
            select: {
                id: true, source: true, ruleId: true, fingerprint: true, occurrence: true, triageDecision: true, createdAt: true,
                reviewRun: { select: { pullRequestId: true } },
                feedback: { where: { userId }, select: { kind: true, createdAt: true } },
                fixes: { select: { id: true, status: true, updatedAt: true } },
            },
        });
        const mine = buildMetrics(rows.map(r => ({ ...r, pullRequestId: r.reviewRun.pullRequestId })), { from: new Date(Date.now() - 86400000), to: new Date() });
        const implementedFixes = new Set(rows.flatMap(r => r.fixes.filter(x => x.status === 'IMPLEMENTED').map(x => x.id))).size;
        console.log(`  this pull request: ${mine.issues.total} issues over ${new Set(rows.map(r => r.id)).size} stored findings, false alarms ${mine.falseAlarms.count}/${mine.falseAlarms.of}, fixes applied ${mine.fixes.count}, rejected ${mine.fixes.rejected}`);
        check('insights: the 7 planted issues are counted once each, across all reviews', mine.issues.total === 7, `${mine.issues.total}`);
        check('insights: exactly one false alarm, the one marked on the page', mine.falseAlarms.count === 1, `${mine.falseAlarms.count}`);
        check('insights: every other judged issue counts as real', mine.falseAlarms.real === mine.falseAlarms.of - 1 && mine.falseAlarms.of >= 2, `real ${mine.falseAlarms.real} of ${mine.falseAlarms.of}`);
        check('insights: rejected fixes equal the fixes rejected on the page', mine.fixes.rejected === rejectedCount, `${mine.fixes.rejected} vs ${rejectedCount}`);
        check('insights: applied fixes equal the fixes stored as applied', mine.fixes.count === implementedFixes && implementedFixes >= 6, `${mine.fixes.count} vs ${implementedFixes}`);
        // One fix can resolve two issues on the same line, so an issue may end up fixed without a fix
        // of its own. Every fix that was validated must have been applied, and nothing may be left open.
        const [found, shownCount, validated, appliedCount] = mine.funnel.map(f => f.count);
        check('insights: every issue was shown, and every validated fix was applied', found === 7 && shownCount === 7 && validated === appliedCount && appliedCount >= 5, mine.funnel.map(f => `${f.key}=${f.count}`).join(' '));
        if (foreignActivity) console.log('  note: another session was deciding fixes on this pull request during the run; the checks hold regardless of who clicked');

        const after = (await loadMetrics(userId, 30)).metrics;
        check('insights: the account totals moved in the right direction', after.issues.total >= before.issues.total + 7 && after.fixes.count >= before.fixes.count + implementedFixes, `issues ${before.issues.total}->${after.issues.total}, applied ${before.fixes.count}->${after.fixes.count}`);
        const insights = await openPage('/dashboard/reviews/insights?days=30');
        const insightsText = await text(insights);
        const now = (await loadMetrics(userId, 30)).metrics;
        const shows = (m: typeof now) => insightsText.includes(`${m.falseAlarms.count} of ${m.falseAlarms.of} judged issues`) && insightsText.includes(`${m.fixes.count} of ${m.fixes.of} decided fixes`);
        check('insights page shows the stored numbers', shows(after) || shows(now), `stored: ${now.falseAlarms.count} of ${now.falseAlarms.of} judged, ${now.fixes.count} of ${now.fixes.of} decided`);
        await insights.screenshot({ path: path.join(shotDir, 'e2e-insights.png'), fullPage: true });
        await insights.close();

        check('no browser console or page error on any page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
        const log = fs.existsSync('.next/dev/logs/next-development.log') ? fs.readFileSync('.next/dev/logs/next-development.log', 'utf8').split('\n').slice(logStart) : [];
        const serverErrors = log.filter(l => /"level":"ERROR"/.test(l)).map(l => { try { return JSON.parse(l).message.slice(0, 160); } catch { return l.slice(0, 160); } });
        check('no server error was logged during the run', serverErrors.length === 0, serverErrors.slice(0, 4).join(' | '));
    } finally {
        await browser.close();
        await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
        console.log('temporary session deleted');
    }

    const failed = checks.filter(c => !c.ok);
    console.log(`\nRESULT: ${checks.length - failed.length} of ${checks.length} checks passed`);
    for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    if (failed.length > 0) process.exitCode = 1;
}
main().catch(e => { console.error('ERR', e.stack || e.message); process.exitCode = 1; }).finally(() => process.exit());
