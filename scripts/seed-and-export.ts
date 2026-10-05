import 'dotenv/config';
import prisma from '../src/lib/db';
import crypto from 'crypto';
import fs from 'fs';

async function main() {
    console.log("Seeding data for dataset export...");

    // Create a mock repo and user if they don't exist
    const user = await prisma.user.upsert({
        where: { id: 'test_user_export' },
        update: {},
        create: {
            id: 'test_user_export',
            name: 'Test',
            email: 'test@example.com',
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    });

    const repository = await prisma.repository.findFirst();
    let repoId = repository?.id;
    if (!repoId) {
        const newRepo = await prisma.repository.create({
            data: {
                githubId: BigInt(Date.now()),
                owner: 'test',
                name: 'test',
                fullName: 'test/test',
                url: 'http://test',
                userId: user.id
            }
        });
        repoId = newRepo.id;
    }

    const pullRequest = await prisma.pullRequest.findFirst({ where: { repositoryId: repoId } });
    let prId = pullRequest?.id;
    if (!prId) {
        const newPr = await prisma.pullRequest.create({
            data: {
                repositoryId: repoId,
                number: 1,
                title: 'Test PR',
                url: 'http://test',
                authorLogin: 'test',
                headRef: 'test',
                headRepoFullName: 'test/test',
                baseRef: 'main',
                latestHeadSha: 'sha1'
            }
        });
        prId = newPr.id;
    }

    const reviewRun = await prisma.reviewRun.findFirst({ where: { repositoryId: repoId } });
    let rrId = reviewRun?.id;
    if (!rrId) {
        const newRr = await prisma.reviewRun.create({
            data: {
                repositoryId: repoId,
                pullRequestId: prId,
                headSha: 'sha1',
                baseSha: 'sha2',
                status: 'COMPLETED',
                trigger: 'MANUAL_RERUN',
                configSnapshot: {}
            }
        });
        rrId = newRr.id;
    }

    const scanRun = await prisma.scanRun.findFirst({ where: { reviewRunId: rrId } });
    let srId = scanRun?.id;
    if (!srId) {
        const newSr = await prisma.scanRun.create({
            data: {
                reviewRunId: rrId,
                kind: 'HEAD',
                source: 'SEMGREP',
                rulesetId: 'ruleset1',
                toolVersion: '1.0',
                status: 'COMPLETED'
            }
        });
        srId = newSr.id;
    }

    // We can just create classifications and findings directly
    const finding = await prisma.finding.create({
        data: {
            reviewRunId: rrId,
            source: 'SEMGREP',
            scanRunId: srId,
            fingerprint: crypto.randomUUID(),
            filePath: 'index.js',
            message: 'Test finding',
            severity: 'HIGH',
            status: 'DETECTED',
            ruleId: 'test-rule-id',
            startLine: 10,
            endLine: 12
        }
    });

    const classification = await prisma.findingClassification.create({
        data: {
            findingId: finding.id,
            modelName: 'prism-exp2-ensemble-v1.0',
            modelVersion: '1.0',
            score: 0.8,
            modelDecision: 'SURFACE',
            finalDecision: 'SURFACE',
            decisionSource: 'MODEL',
            featureSnapshot: {
                "numTokens": 10,
                "cyclomaticComplexity": 2
            }
        }
    });

    await prisma.findingFeedback.create({
        data: {
            findingId: finding.id,
            userId: user.id,
            kind: 'TRUE_POSITIVE'
        }
    });

    console.log("Data seeded. Running export logic...");

    // Export logic
    const classifications = await prisma.findingClassification.findMany({
        include: {
            finding: {
                include: {
                    feedback: true,
                    fixes: {
                        include: {
                            validationRuns: {
                                include: { validationResults: true }
                            }
                        }
                    }
                }
            }
        }
    });

    const records: any[] = [];
    for (const c of classifications) {
        const f = c.finding;
        if (!f) continue;

        let label = "UNKNOWN";

        const hasRejectFeedback = f.feedback.some(fb => fb.kind === 'FIX_REJECTED' || fb.kind === 'FALSE_POSITIVE');
        const hasAcceptFeedback = f.feedback.some(fb => fb.kind === 'FIX_ACCEPTED' || fb.kind === 'TRUE_POSITIVE');
        
        if (hasRejectFeedback) {
            label = "FALSE_POSITIVE";
        } else if (hasAcceptFeedback) {
            label = "TRUE_POSITIVE";
        } else if (f.fixes.some(fix => fix.outcome === 'FIXED' || fix.status === 'IMPLEMENTED')) {
            label = "FIXED";
        } else if (f.fixes.some(fix => fix.outcome === 'NOT_FIXED')) {
            label = "NOT_FIXED";
        } else {
            label = c.finalDecision;
        }

        records.push({
            featureSnapshot: c.featureSnapshot,
            score: c.score,
            modelName: c.modelName,
            modelVersion: c.modelVersion,
            policyVersion: c.policyVersion,
            label,
            timestamp: c.createdAt.toISOString()
        });
    }

    const labelDistribution = records.reduce((acc, r) => {
        acc[r.label] = (acc[r.label] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    const basePayload = {
        datasetVersion: "1.0.0",
        modelFeatureSchemaVersion: "1.0",
        createdAt: new Date().toISOString(),
        rowCount: records.length,
        labelDistribution,
        records
    };

    const checksum = crypto.createHash('sha256').update(JSON.stringify(basePayload)).digest('hex');
    const payload = { ...basePayload, checksum };

    fs.writeFileSync('dataset.json', JSON.stringify(payload, null, 2));
    console.log(`Exported dataset with ${payload.rowCount} records to dataset.json`);
    console.log("Label distribution:", payload.labelDistribution);
}

main().catch(console.error);
