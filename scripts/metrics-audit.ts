/**
 * Read-only audit of the numbers behind the review pages: feedback duplicates, run counters
 * compared with the rows they summarise, and fix decisions.
 * Usage: npx tsx --env-file=.env p0-metrics-audit.ts
 */
import { prisma } from '../src/lib/db';

async function main() {
    const users = await prisma.user.count();
    const repos = await prisma.repository.count();
    console.log(`users=${users} repositories=${repos}`);

    const fb = await prisma.findingFeedback.groupBy({ by: ['kind'], _count: true });
    console.log('feedback by kind:', fb.map(f => `${f.kind}=${f._count}`).join(' '));

    const dup = await prisma.$queryRawUnsafe<any[]>(
        'select "findingId","userId","kind",count(*)::int as n from "findingFeedback" group by 1,2,3 having count(*)>1 order by n desc limit 10'
    );
    console.log(`duplicate (finding,user,kind) groups (top 10): ${dup.length}`, dup.map(d => `${d.kind}x${d.n}`).join(' '));
    const both = await prisma.$queryRawUnsafe<any[]>(
        `select count(*)::int as n from (select "findingId","userId" from "findingFeedback" where "kind" in ('TRUE_POSITIVE','FALSE_POSITIVE') group by 1,2 having count(distinct "kind")>1) t`
    );
    console.log(`findings one user marked both real and false alarm: ${both[0].n}`);
    const orphan = await prisma.$queryRawUnsafe<any[]>(
        `select count(*)::int as n from "findingFeedback" fb join "finding" f on f.id=fb."findingId" join "reviewRun" r on r.id=f."reviewRunId" join "repository" repo on repo.id=r."repositoryId" where repo."userId" <> fb."userId"`
    );
    console.log(`feedback rows written by someone who does not own the repository: ${orphan[0].n}`);

    // Run counters against the rows they summarise
    const runs = await prisma.reviewRun.findMany({
        select: { id: true, status: true, totalFindings: true, surfacedCount: true, suppressedCount: true, fixesGenerated: true, fixesReady: true, fixesFailed: true,
            findings: { select: { source: true, triageDecision: true, fixes: { select: { status: true } } } } }
    });
    let wrong = 0;
    const examples: string[] = [];
    for (const r of runs) {
        const scanner = r.findings.filter(f => f.source !== 'CUSTOM');
        const real = {
            total: scanner.length,
            surfaced: scanner.filter(f => f.triageDecision === 'SURFACE').length,
            suppressed: scanner.filter(f => f.triageDecision === 'SUPPRESS').length,
            ready: scanner.flatMap(f => f.fixes).filter(x => x.status === 'READY').length,
        };
        const bad = r.totalFindings !== real.total || r.surfacedCount !== real.surfaced || r.suppressedCount !== real.suppressed || r.fixesReady !== real.ready;
        if (bad) {
            wrong++;
            if (examples.length < 8) examples.push(`  ${r.id.slice(0, 8)} ${r.status} stored total/surf/supp/ready=${r.totalFindings}/${r.surfacedCount}/${r.suppressedCount}/${r.fixesReady} actual=${real.total}/${real.surfaced}/${real.suppressed}/${real.ready}`);
        }
    }
    console.log(`runs=${runs.length} runs whose stored counters differ from their rows=${wrong}`);
    examples.forEach(e => console.log(e));
    const byStatus = new Map<string, number>();
    runs.forEach(r => byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1));
    console.log('runs by status:', Array.from(byStatus).map(([k, v]) => `${k}=${v}`).join(' '));

    const fixes = await prisma.suggestedFix.groupBy({ by: ['status'], _count: true });
    console.log('fixes by status:', fixes.map(f => `${f.status}=${f._count}`).join(' '));
    const applies = await prisma.applyAttempt.groupBy({ by: ['status'], _count: true });
    console.log('apply attempts by status:', applies.map(f => `${f.status}=${f._count}`).join(' '));

    const idx = await prisma.$queryRawUnsafe<any[]>(`select indexname from pg_indexes where tablename='findingFeedback'`);
    console.log('findingFeedback indexes:', idx.map(i => i.indexname).join(', '));
    const mig = await prisma.$queryRawUnsafe<any[]>(`select migration_name from "_prisma_migrations" order by finished_at desc limit 4`).catch(() => []);
    console.log('latest applied migrations:', mig.map(m => m.migration_name).join(', '));
    const cols = await prisma.$queryRawUnsafe<any[]>(`select column_name from information_schema.columns where table_name='repository' and column_name in ('holisticReview','executionValidation')`);
    console.log('repository flag columns:', cols.map(c => c.column_name).join(', '));
}
main().catch(e => { console.error('ERR', e.message); process.exitCode = 1; }).finally(() => process.exit());
