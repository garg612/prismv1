// The rules PRism lints every repository with. The repository's own ESLint configuration is
// never loaded: a config file is code, and running a pull request's code inside the scanner
// would let it decide its own review.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const JS_FILES = ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];
const TS_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

export default [
    {
        ignores: [
            "**/node_modules/**", "**/dist/**", "**/build/**", "**/out/**", "**/.next/**", "**/coverage/**",
            "**/vendor/**", "**/generated/**", "**/*.min.js", "**/*.bundle.js", "**/*.d.ts",
        ],
    },
    {
        files: JS_FILES,
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: "latest",
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: { ...globals.node, ...globals.browser, ...globals.es2024 },
        },
        // A stale "eslint-disable" comment in the repository is not something to review.
        linterOptions: { reportUnusedDisableDirectives: "off" },
    },
    // Syntax-only TypeScript rules: nothing here needs the project's tsconfig or its dependencies.
    ...tseslint.configs.recommended.map(config => ({
        ...config,
        files: TS_FILES,
        linterOptions: { reportUnusedDisableDirectives: "off" },
    })),
];
