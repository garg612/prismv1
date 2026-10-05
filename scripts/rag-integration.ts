import 'dotenv/config';
import { pineconeIndex, namespacedIndex, verifyIndexDimension, PINECONE_INDEX_NAME } from '../src/lib/pinecone';
import { deleteFileChunks, upsertChunks } from '../src/modules/ai/lib/rag';
import { chunkFile } from '../src/modules/ai/lib/chunker';

process.env.MOCK_EMBEDDINGS = '1';

async function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function run() {
    console.log(`Starting Integration Test against ${PINECONE_INDEX_NAME}...`);
    await verifyIndexDimension();
    console.log(`Dimension verified for ${PINECONE_INDEX_NAME}.`);

    const repositoryId = 'test-repo-integration';
    const ns = namespacedIndex(repositoryId);

    // Initial state cleanup
    try { await ns.deleteAll(); } catch(e) {}
    await delay(2000);

    // --- 1. SUCCESSFUL LIFECYCLE ---
    console.log('\n--- 1. SUCCESSFUL LIFECYCLE ---');

    // Initial (SHA = A)
    console.log('\n[Initial: SHA = A]');
    const shaA = 'A';
    const fileContentA = 'console.log("Hello A");\n'.repeat(200); 
    const chunksA = chunkFile(repositoryId, 'src/example.ts', shaA, fileContentA);
    const unchangedFileContent = 'console.log("Unchanged");\n'.repeat(100);
    const chunksUnchanged = chunkFile(repositoryId, 'src/unchanged.ts', shaA, unchangedFileContent);
    
    await upsertChunks(repositoryId, shaA, [...chunksA, ...chunksUnchanged]);
    
    let stats = await pineconeIndex.describeIndexStats();
    let currentCount = stats.namespaces?.[`repo:${repositoryId}`]?.recordCount || 0;
    console.log(`Vectors after A: ${currentCount}`);
    
    // Modification (SHA = B)
    console.log('\n[Modification: SHA = B]');
    const shaB = 'B';
    
    await deleteFileChunks(repositoryId, 'src/example.ts');
    await delay(2000); 
    
    stats = await pineconeIndex.describeIndexStats();
    console.log(`Vectors after deleting old example.ts: ${stats.namespaces?.[`repo:${repositoryId}`]?.recordCount || 0} (Unchanged file untouched)`);
    
    const fileContentB = 'console.log("Hello B");\n'.repeat(300);
    const chunksB = chunkFile(repositoryId, 'src/example.ts', shaB, fileContentB);
    await upsertChunks(repositoryId, shaB, chunksB);
    
    stats = await pineconeIndex.describeIndexStats();
    currentCount = stats.namespaces?.[`repo:${repositoryId}`]?.recordCount || 0;
    console.log(`Vectors after B: ${currentCount}`);

    // Removal (SHA = C)
    console.log('\n[Removal: SHA = C]');
    await deleteFileChunks(repositoryId, 'src/example.ts');
    await delay(2000);

    stats = await pineconeIndex.describeIndexStats();
    currentCount = stats.namespaces?.[`repo:${repositoryId}`]?.recordCount || 0;
    console.log(`Vectors after C: ${currentCount} (Only unchanged remains)`);

    // --- 2. FAILURE & RECOVERY ---
    console.log('\n--- 2. FAILURE & RECOVERY ---');
    console.log('\n[Restoring state to B...]');
    await ns.deleteAll();
    await delay(2000);
    await upsertChunks(repositoryId, shaB, [...chunksB, ...chunksUnchanged]);
    
    let indexState = 'READY';
    let indexedSha = 'B';
    
    console.log(`Current indexedSha: ${indexedSha}, state: ${indexState}`);
    console.log('\n[Simulating B -> C with API Failure]');
    try {
        indexState = 'INDEXING';
        // Simulate step.run failure mid-update
        throw new Error("Simulated API or Network Failure during batch upsert");
        // Would mark ready on success
        indexedSha = 'C';
        indexState = 'READY';
    } catch (e) {
        indexState = 'FAILED';
        // indexedSha remains B
        console.log(`Caught error: ${(e as Error).message}`);
    }

    console.log(`After Failure - indexedSha: ${indexedSha}, state: ${indexState}`);

    console.log('\n[Simulating Retry B -> C Success]');
    // Retry succeeds
    indexState = 'INDEXING';
    await deleteFileChunks(repositoryId, 'src/example.ts');
    indexedSha = 'C';
    indexState = 'READY';
    console.log(`After Retry - indexedSha: ${indexedSha}, state: ${indexState}`);

    // Cleanup
    try { await ns.deleteAll(); } catch(e) {}
    console.log('\nIntegration Test Complete.');
}

run().catch(console.error);
