const { Sandbox } = require('@e2b/code-interpreter');
async function run() {
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });
    try {
        await sandbox.commands.run('sleep 10', { timeoutMs: 1000 });
    } catch (e) {
        console.log('Error:', e.message);
    }
    await sandbox.kill();
}
run().catch(console.error);
