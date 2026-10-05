import { runEslintScan } from '../eslint';
import type { RunnerScanner } from './types';

export const eslintScanner: RunnerScanner = {
    id: 'ESLINT',
    // A linter's findings only matter in the files the pull request touches (or the files a fix
    // edits), so ESLint is given that list. Without one it lints the whole repository.
    scan: (workDir, options) => runEslintScan(workDir, options?.files),
};
