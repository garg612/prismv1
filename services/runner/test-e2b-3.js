const { Sandbox } = require('@e2b/code-interpreter');
const fs = require('fs');
async function run() {
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });
    
    // 1. ISOLATION
    const ISOLATION_SCRIPT_PATH = '/tmp/prism-isolate.sh';
    const ISOLATION_SCRIPT = [
        '#!/bin/bash',
        'set -euo pipefail',
        "DNS_IP=$(awk '/^nameserver/ {print ; exit}' /etc/resolv.conf)",
        'test -n "$DNS_IP"',
        'iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
        'iptables -A OUTPUT -o lo -j ACCEPT',
        'echo conntrack-armed',
        'sleep 2',
        'iptables -A OUTPUT -p udp --dport 53 -d "$DNS_IP" -j ACCEPT',
        'iptables -A OUTPUT -p tcp --dport 53 -d "$DNS_IP" -j ACCEPT',
        'iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT',
        'iptables -A OUTPUT -d 172.16.0.0/12 -j REJECT',
        'iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT',
        'iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT',
        ''
    ].join('\n');
    await sandbox.files.write(ISOLATION_SCRIPT_PATH, ISOLATION_SCRIPT);
    const isoRes = await sandbox.commands.run('bash ' + ISOLATION_SCRIPT_PATH, { user: 'root' });
    console.log('Iso:', isoRes.exitCode, isoRes.stdout, isoRes.stderr);

    // 2. WORKSPACE
    await sandbox.commands.run('mkdir -p /home/user/workspace');
    const pkg = fs.readFileSync('C:/Users/gargk/OneDrive/Desktop/Prisme/prism-test-v1/package.json', 'utf8');
    const lock = fs.readFileSync('C:/Users/gargk/OneDrive/Desktop/Prisme/prism-test-v1/package-lock.json', 'utf8');
    await sandbox.files.write('/home/user/workspace/package.json', pkg);
    await sandbox.files.write('/home/user/workspace/package-lock.json', lock);
    
    // 3. RUN NPM CI
    try {
        const res = await sandbox.commands.run('npm ci --ignore-scripts', { cwd: '/home/user/workspace' });
        console.log('Success:', res.exitCode);
    } catch (e) {
        console.log('Error thrown!');
        console.log('Message:', e.message);
    }
    await sandbox.kill();
}
run().catch(console.error);
