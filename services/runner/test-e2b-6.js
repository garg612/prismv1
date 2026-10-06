const { Sandbox } = require('@e2b/code-interpreter');
const fs = require('fs');
async function run() {
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });
    
    // Simulate completely blocked network
    await sandbox.commands.run('iptables -A OUTPUT -j REJECT', { user: 'root' });

    await sandbox.commands.run('mkdir -p /home/user/workspace');
    const pkg = fs.readFileSync('C:/Users/gargk/OneDrive/Desktop/Prisme/prism-test-v1/package.json', 'utf8');
    const lock = fs.readFileSync('C:/Users/gargk/OneDrive/Desktop/Prisme/prism-test-v1/package-lock.json', 'utf8');
    await sandbox.files.write('/home/user/workspace/package.json', pkg);
    await sandbox.files.write('/home/user/workspace/package-lock.json', lock);
    
    try {
        const res = await sandbox.commands.run('npm ci --ignore-scripts', { cwd: '/home/user/workspace' });
        console.log('Success:', res.exitCode);
    } catch (e) {
        console.log('Error thrown!');
        console.log('Message:', e.message);
        console.log('Stdout:', e.result?.stdout);
        console.log('Stderr:', e.result?.stderr);
    }
    await sandbox.kill();
}
run().catch(console.error);
