import { Finding } from "@/generated/prisma/client";

export interface MLFeaturePayload {
    finding_id: string;
    language: string;
    rule_id: string;
    severity: string;
    function_length: number;
    cyclomatic_complexity: number;
    file_size_lines: number;
    pr_changed_lines: number;
    historical_rule_fp_rate: number;
    file_churn_90d: number;
    repo_finding_density_per_1k_loc: number;
    pr_change_code: string;
}

export function buildMLFeatures(
    finding: Finding, 
    prChangedLines: number,
    ruleFPRate: number | null,
    fileChurn90d: number | null,
    repoDensity: number | null
): MLFeaturePayload | null {
    const filePath = finding.filePath.toLowerCase();
    const isSupportedLang = filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.tsx');
    if (!isSupportedLang) {
        return null;
    }

    const metadata = (finding.metadata as any) || {};
    const prismFeatures = metadata.prism_features;
    if (!prismFeatures) return null;

    const fileSizeLines = prismFeatures.fileSizeLines;
    const functionLength = prismFeatures.functionLength;
    const cyclomaticComplexity = prismFeatures.cyclomaticComplexity;

    // Structural features are measured from the real file by the runner. If any is
    // missing we do not invent a value: the finding is routed by policy instead.
    const isMeasured = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!isMeasured(fileSizeLines) || fileSizeLines < 1 || !isMeasured(functionLength) || !isMeasured(cyclomaticComplexity)) {
        return null;
    }

    const normalizedFileSizeLines = fileSizeLines;
    const normalizedFunctionLength = functionLength;
    const normalizedCyclomaticComplexity = cyclomaticComplexity;

    // Historical metrics: use safe defaults when sparse data is unavailable
    const normalizedRuleFPRate = ruleFPRate === null ? 0.05 : ruleFPRate;
    const normalizedFileChurn90d = fileChurn90d === null ? 0 : fileChurn90d;
    const normalizedRepoDensity = repoDensity === null ? 0 : repoDensity;

    let codeSnippet = finding.codeSnippet || "";
    if (codeSnippet.length > 500) codeSnippet = codeSnippet.substring(0, 500);

    return {
        finding_id: finding.id,
        language: "javascript",
        rule_id: finding.ruleId,
        severity: finding.severity.toLowerCase(),
        function_length: normalizedFunctionLength,
        cyclomatic_complexity: normalizedCyclomaticComplexity,
        file_size_lines: normalizedFileSizeLines,
        pr_changed_lines: prChangedLines,
        historical_rule_fp_rate: normalizedRuleFPRate,
        file_churn_90d: normalizedFileChurn90d,
        repo_finding_density_per_1k_loc: normalizedRepoDensity,
        pr_change_code: codeSnippet
    };
}
