export interface SecretFinding {
    type: string;
    evidence: string;
}

const SECRET_PATTERNS = [
    { type: "GitHub Token", regex: /gh[pousr]_[A-Za-z0-9]{36}/ },
    { type: "Bearer Token", regex: /Bearer\s+[A-Za-z0-9\-_=\.]{20,}/i },
    { type: "AWS Access Key", regex: /(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/ },
    { type: "Private Key", regex: /-----BEGIN\s+(RSA|OPENSSH|DSA|EC|PGP)\s+PRIVATE\s+KEY-----/ },
    { type: "Generic Secret", regex: /(?:secret|token|password|api_key|apikey|auth_token)['"]?\s*[:=]\s*['"]?([A-Za-z0-9\-_=\.]{16,})['"]?/i }
];

function calculateEntropy(str: string): number {
    const chars = new Map<string, number>();
    for (const c of str) {
        chars.set(c, (chars.get(c) || 0) + 1);
    }
    let entropy = 0;
    for (const count of chars.values()) {
        const p = count / str.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

export function scanForSecrets(content: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    
    // Pattern based
    for (const pattern of SECRET_PATTERNS) {
        const match = pattern.regex.exec(content);
        if (match) {
            findings.push({
                type: pattern.type,
                evidence: "Redacted potential secret detected"
            });
        }
    }

    // High entropy strings (basic heuristic)
    const words = content.split(/[\s,"'=\n\r]+/);
    for (const word of words) {
        if (word.length > 20 && word.length < 100) {
            const entropy = calculateEntropy(word);
            // typical english text entropy is lower; base64 strings have high entropy
            if (entropy > 4.5 && !word.includes('http') && !word.includes('console')) {
                // To avoid false positives on very long variables, we're conservative
                if (/[A-Z]/.test(word) && /[0-9]/.test(word)) {
                    findings.push({
                        type: "High Entropy String",
                        evidence: "Redacted high entropy string"
                    });
                    break;
                }
            }
        }
    }

    return findings;
}
