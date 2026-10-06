const { Sandbox } = require('@e2b/code-interpreter');
async function run() {
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });
    await sandbox.commands.run('mkdir -p /home/user/workspace');
    await sandbox.files.write('/home/user/workspace/package.json', 
{
  "name": "prism-test-repo",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "jest": "^29.5.0",
    "eslint": "^8.36.0"
  }
}
    );
    try {
        const res = await sandbox.commands.run('npm ci --ignore-scripts', { cwd: '/home/user/workspace' });
        console.log('Success:', res);
    } catch (e) {
        console.log('Error thrown!');
        console.log('Message:', e.message);
        console.log('Stdout:', e.result?.stdout);
        console.log('Stderr:', e.result?.stderr);
    }
    await sandbox.kill();
}
run().catch(console.error);
