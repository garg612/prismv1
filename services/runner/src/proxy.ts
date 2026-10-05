import net from 'net';
import http from 'http';
import url from 'url';

const ALLOWED_HOSTS = [
    'registry.npmjs.org',
    'registry.yarnpkg.com'
];

export function startEgressProxy(port: number): http.Server {
    const server = http.createServer((req, res) => {
        // Handle HTTP requests (if any)
        const reqUrl = url.parse(req.url!);
        const host = reqUrl.hostname;
        
        if (!host || !ALLOWED_HOSTS.includes(host)) {
            res.writeHead(403);
            res.end('Forbidden by PRism egress proxy');
            return;
        }

        // Extremely simplified HTTP proxy (npm uses HTTPS mostly anyway)
        res.writeHead(501);
        res.end('Use CONNECT');
    });

    server.on('connect', (req, clientSocket, head) => {
        const reqUrl = url.parse(`http://${req.url}`);
        const host = reqUrl.hostname;
        const port = reqUrl.port ? parseInt(reqUrl.port) : 443;

        if (!host || !ALLOWED_HOSTS.includes(host)) {
            clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            clientSocket.end();
            return;
        }

        // Block RFC1918 and AWS Metadata
        if (host === '169.254.169.254' || host === '127.0.0.1' || host === 'localhost') {
            clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            clientSocket.end();
            return;
        }
        
        const serverSocket = net.connect(port, host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                                'Proxy-agent: PRism-Egress-Proxy\r\n' +
                                '\r\n');
            serverSocket.write(head);
            serverSocket.pipe(clientSocket);
            clientSocket.pipe(serverSocket);
        });

        serverSocket.on('error', (err) => {
            clientSocket.end();
        });

        clientSocket.on('error', (err) => {
            serverSocket.end();
        });
    });

    server.listen(port, '127.0.0.1');
    return server;
}
