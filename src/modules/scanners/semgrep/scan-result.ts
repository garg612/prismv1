import { normalizeFinding } from './normalize';
import { SemgrepResultSchema } from './schema';
import type { NormalizedFinding, ScanCallbackData, ScanEvaluation } from '@/modules/scanners/types';

export type { ScanCallbackData, ScanEvaluation };

/**
 * Turn a runner scan callback (or its absence) into either a trustworthy finding
 * list or an explicit failure. An empty finding list is only ever returned for a
 * scan that completed and reported no fatal errors.
 */
export function evaluateScanCallback(data: ScanCallbackData | null | undefined): ScanEvaluation {
    if (!data) {
        return { ok: false, code: 'SCAN_TIMEOUT', error: 'No result was received from the runner in time', jobStatus: 'TIMEOUT' };
    }

    if (data.status !== 'COMPLETED') {
        return {
            ok: false,
            code: data.errorCode || 'SCAN_FAILED',
            error: data.error || 'Runner reported a failed scan',
            jobStatus: 'FAILED'
        };
    }

    if (data.toolResult === undefined || data.toolResult === null) {
        return { ok: false, code: 'SCAN_RESULT_MISSING', error: 'Runner reported success without a scan result', jobStatus: 'FAILED' };
    }
    // The callback carries the tool's output untyped; this is where Semgrep's shape is enforced.
    const parsed = SemgrepResultSchema.safeParse(data.toolResult);
    if (!parsed.success) {
        return { ok: false, code: 'SCAN_RESULT_INVALID', error: 'Scan result is not valid Semgrep output', jobStatus: 'FAILED' };
    }
    const result = parsed.data;

    const errors = result.errors || [];
    const fatal = errors.filter((e: any) => String(e?.level || '').toLowerCase() === 'error');
    if (fatal.length > 0) {
        return {
            ok: false,
            code: 'SCAN_TOOL_ERRORS',
            error: `Semgrep reported ${fatal.length} error(s): ${String((fatal[0] as any)?.message || (fatal[0] as any)?.type || 'unknown').slice(0, 300)}`,
            jobStatus: 'FAILED'
        };
    }

    // Semgrep OSS emits this placeholder instead of source lines; the runner replaces it
    // with the real text. Seeing it here means the result was not canonicalized.
    if (result.results.some(r => r.extra?.lines === 'requires login')) {
        return { ok: false, code: 'SCAN_SNIPPET_UNAVAILABLE', error: 'Scan result does not contain real source lines', jobStatus: 'FAILED' };
    }

    let findings: NormalizedFinding[];
    try {
        findings = result.results.map(normalizeFinding);
    } catch (e: any) {
        return { ok: false, code: 'SCAN_NON_CANONICAL_PATH', error: e?.message || 'Scan result contains an invalid path', jobStatus: 'FAILED' };
    }

    return {
        ok: true,
        findings,
        toolWarnings: errors,
        scannedFiles: result.paths?.scanned ? result.paths.scanned.length : null,
        toolVersion: result.version ?? null
    };
}
