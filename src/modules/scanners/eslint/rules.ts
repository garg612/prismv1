import type { FindingCategory, Severity } from "@/generated/prisma/client";

/**
 * ESLint's classic rule groups, as the triage model was trained to see them ("variables",
 * "possible-errors", ...). A rule that is not listed is "other": never guessed into a group.
 */
const FAMILY_RULES: Record<string, string[]> = {
    "possible-errors": [
        "for-direction", "getter-return", "no-async-promise-executor", "no-compare-neg-zero", "no-cond-assign",
        "no-constant-binary-expression", "no-constant-condition", "no-control-regex", "no-debugger", "no-dupe-args",
        "no-dupe-else-if", "no-dupe-keys", "no-duplicate-case", "no-empty", "no-empty-character-class",
        "no-empty-static-block", "no-ex-assign", "no-extra-boolean-cast", "no-func-assign", "no-import-assign",
        "no-inner-declarations", "no-invalid-regexp", "no-irregular-whitespace", "no-loss-of-precision",
        "no-misleading-character-class", "no-new-native-nonconstructor", "no-obj-calls", "no-prototype-builtins",
        "no-regex-spaces", "no-setter-return", "no-sparse-arrays", "no-unexpected-multiline", "no-unreachable",
        "no-unsafe-finally", "no-unsafe-negation", "no-unsafe-optional-chaining", "no-unused-private-class-members",
        "no-useless-backreference", "use-isnan", "valid-typeof",
    ],
    "best-practices": [
        "no-case-declarations", "no-empty-pattern", "no-fallthrough", "no-global-assign", "no-nonoctal-decimal-escape",
        "no-octal", "no-redeclare", "no-self-assign", "no-unused-labels", "no-useless-catch", "no-useless-escape", "no-with",
    ],
    "variables": ["no-delete-var", "no-shadow-restricted-names", "no-undef", "no-unused-vars"],
    "es6": [
        "constructor-super", "no-class-assign", "no-const-assign", "no-dupe-class-members", "no-new-symbol",
        "no-this-before-super", "prefer-const", "require-yield", "no-var", "prefer-rest-params", "prefer-spread",
    ],
};

const FAMILY_BY_RULE = new Map<string, string>(
    Object.entries(FAMILY_RULES).flatMap(([family, rules]) => rules.map(rule => [rule, family] as [string, string]))
);

/** Rules whose finding means the code is wrong, not merely untidy */
const CORRECTNESS_RULES = new Set([
    ...FAMILY_RULES["possible-errors"],
    "no-undef", "no-delete-var", "no-shadow-restricted-names",
    "constructor-super", "no-class-assign", "no-const-assign", "no-dupe-class-members", "no-new-symbol", "no-this-before-super", "require-yield",
    "no-fallthrough", "no-global-assign", "no-redeclare", "no-self-assign", "no-with", "no-case-declarations",
    "@typescript-eslint/no-misused-new", "@typescript-eslint/no-unsafe-declaration-merging", "@typescript-eslint/no-this-alias",
    "@typescript-eslint/no-unsafe-function-type", "@typescript-eslint/no-duplicate-enum-values",
]);
const STYLE_RULES = new Set(["prefer-const", "no-var", "prefer-rest-params", "prefer-spread", "no-extra-boolean-cast", "no-regex-spaces", "no-useless-escape"]);
const MAINTAINABILITY_RULES = new Set([
    "no-unused-vars", "no-unused-labels", "no-unused-private-class-members", "no-useless-catch", "no-empty", "no-empty-pattern",
    "@typescript-eslint/no-unused-vars", "@typescript-eslint/no-explicit-any", "@typescript-eslint/no-unused-expressions",
    "@typescript-eslint/no-empty-object-type", "@typescript-eslint/ban-ts-comment",
]);

/** The name of the rule without a "@typescript-eslint/" style plugin prefix */
const baseRule = (ruleId: string) => ruleId.slice(ruleId.lastIndexOf("/") + 1);

export function ruleFamily(ruleId: string): string {
    if (ruleId.startsWith("@typescript-eslint/")) return FAMILY_BY_RULE.get(baseRule(ruleId)) ?? "typescript";
    return FAMILY_BY_RULE.get(ruleId) ?? "other";
}

export function eslintCategory(ruleId: string): FindingCategory {
    // A style or maintainability verdict wins over the group the rule happens to be listed in.
    if (STYLE_RULES.has(ruleId) || STYLE_RULES.has(baseRule(ruleId))) return "STYLE";
    if (MAINTAINABILITY_RULES.has(ruleId)) return "MAINTAINABILITY";
    if (CORRECTNESS_RULES.has(ruleId)) return "CORRECTNESS";
    return "BEST_PRACTICE";
}

/** ESLint knows two levels. A lint error is a medium-severity finding; nothing a linter reports is "high". */
export function eslintSeverity(severity: 1 | 2): Severity {
    return severity === 2 ? "MEDIUM" : "LOW";
}

export const eslintSeverityText = (severity: 1 | 2) => (severity === 2 ? "error" : "warning");
