const { Sandbox } = require('@e2b/code-interpreter');
async function run() {
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });
    const resNode = await sandbox.commands.run('node -v');
    console.log('Node:', resNode.stdout, resNode.stderr);
    const resNpm = await sandbox.commands.run('npm -v');
    console.log('Npm:', resNpm.stdout, resNpm.stderr);
    await sandbox.kill();
}
run().catch(console.error);
