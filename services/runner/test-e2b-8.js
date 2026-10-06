const { Sandbox } = require('@e2b/code-interpreter');
const fs = require('fs');
const tar = require('tar');

async function run() {
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });
    await sandbox.commands.run('mkdir -p /home/user/workspace');
    
    // Create a dummy project in a temp folder
    fs.mkdirSync('dummy-project', { recursive: true });
    const pkg = fs.readFileSync('C:/Users/gargk/OneDrive/Desktop/Prisme/prism-test-v1/package.json', 'utf8');
    const lock = fs.readFileSync('C:/Users/gargk/OneDrive/Desktop/Prisme/prism-test-v1/package-lock.json', 'utf8');
    fs.writeFileSync('dummy-project/package.json', pkg);
    fs.writeFileSync('dummy-project/package-lock.json', lock);
    
    // Pack it like PRism does
    await tar.c({ gzip: true, cwd: 'dummy-project', file: 'workspace.tar.gz' }, ['.']);
    
    // Upload it
    const tarContent = fs.readFileSync('workspace.tar.gz');
    await sandbox.files.write('/tmp/workspace.tar.gz', tarContent);
    
    // Unpack it
    await sandbox.commands.run('tar -xzf /tmp/workspace.tar.gz -C /home/user/workspace');
    
    // Check permissions
    const ls = await sandbox.commands.run('ls -la /home/user/workspace');
    console.log('LS:', ls.stdout);
    
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
