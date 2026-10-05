import crypto from 'crypto';

export function signHmac(payload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyHmac(payload: string, signature: string, secret: string): boolean {
    try {
        const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
        return false;
    }
}

export async function requestScan(scanRunId: string, tarballUrl: string, changedFiles: string[] | undefined, tool: string) {
    let baseUrl = process.env.RUNNER_URL || 'http://127.0.0.1:4000/v1/jobs';
    if (baseUrl.endsWith('/scan')) baseUrl = baseUrl.replace('/scan', '/v1/jobs');
    const RUNNER_HMAC_SECRET = process.env.RUNNER_HMAC_SECRET;

    if (!RUNNER_HMAC_SECRET) {
        throw new Error("Missing RUNNER_HMAC_SECRET");
    }

    const payloadObj = {
        type: 'SCAN',
        tool,
        scanRunId,
        tarballUrl,
        changedFiles,
        timestamp: Date.now()
    };
    
    const payloadStr = JSON.stringify(payloadObj);
    const signature = signHmac(payloadStr, RUNNER_HMAC_SECRET);

    const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Runner-Signature': signature
        },
        body: payloadStr
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Runner rejected request: ${res.status} ${text}`);
    }
    
    return true;
}

/** `files`: repository-relative files the re-scan must cover besides the edited ones (the file the issue is in). */
export async function requestValidation(validationRunId: string, tarballUrl: string, edits: { path: string, find: string, replace: string }[], tool: string, files?: string[]) {
    let baseUrl = process.env.RUNNER_URL || 'http://127.0.0.1:4000/v1/jobs';
    if (baseUrl.endsWith('/scan')) baseUrl = baseUrl.replace('/scan', '/v1/jobs');
    const RUNNER_HMAC_SECRET = process.env.RUNNER_HMAC_SECRET;

    if (!RUNNER_HMAC_SECRET) {
        throw new Error("Missing RUNNER_HMAC_SECRET");
    }

    const payloadObj = {
        type: 'STATIC_VALIDATE',
        tool,
        validationRunId,
        tarballUrl,
        edits,
        changedFiles: files,
        timestamp: Date.now()
    };
    
    const payloadStr = JSON.stringify(payloadObj);
    const signature = signHmac(payloadStr, RUNNER_HMAC_SECRET);

    const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Runner-Signature': signature
        },
        body: payloadStr
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Runner rejected validate request: ${res.status} ${text}`);
    }
    
    return true;
}

export async function requestExecutionValidation(validationRunId: string, tarballUrl: string, edits: { path: string, find: string, replace: string }[], baselineKey?: string) {
    let baseUrl = process.env.RUNNER_URL || 'http://127.0.0.1:4000/v1/jobs';
    if (baseUrl.endsWith('/scan')) baseUrl = baseUrl.replace('/scan', '/v1/jobs');
    const RUNNER_HMAC_SECRET = process.env.RUNNER_HMAC_SECRET;

    if (!RUNNER_HMAC_SECRET) {
        throw new Error("Missing RUNNER_HMAC_SECRET");
    }

    const payloadObj = {
        type: 'EXEC_VALIDATE',
        // Identifies the unmodified tree (repository + commit) so its test run can be shared between fixes
        baselineKey,
        validationRunId,
        tarballUrl,
        edits,
        timestamp: Date.now()
    };
    
    const payloadStr = JSON.stringify(payloadObj);
    const signature = signHmac(payloadStr, RUNNER_HMAC_SECRET);

    const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Runner-Signature': signature
        },
        body: payloadStr
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Runner rejected exec validate request: ${res.status} ${text}`);
    }
    
    return true;
}
