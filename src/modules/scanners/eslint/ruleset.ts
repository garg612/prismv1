import crypto from "crypto";
import fs from "fs";
import path from "path";

let cachedHash: string | null = null;

/**
 * Identifies the exact rules ESLint ran with: the configuration and the pinned package versions
 * baked into the prism-eslint image. Either changing can change the findings.
 */
export function getEslintRulesetId(): string {
    if (cachedHash) return cachedHash;
    const dir = path.resolve(process.cwd(), "services/runner/eslint");
    const files = ["eslint.config.mjs", "package.json"].map(name => path.join(dir, name));
    if (!files.every(f => fs.existsSync(f))) return "sha256:unknown";

    const hash = crypto.createHash("sha256");
    for (const file of files) hash.update(fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n"));
    cachedHash = `sha256:${hash.digest("hex")}`;
    return cachedHash;
}
