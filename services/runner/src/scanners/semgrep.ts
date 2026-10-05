import path from 'path';
import { runSemgrepScan } from '../semgrep';
import type { RunnerScanner } from './types';

const SEMGREP_RULESET_PATH = process.env.SEMGREP_RULESET_PATH || path.resolve(__dirname, '../../../../rules/semgrep/prism-test.yaml');

export const semgrepScanner: RunnerScanner = {
    id: 'SEMGREP',
    scan: workDir => runSemgrepScan(workDir, SEMGREP_RULESET_PATH),
};
