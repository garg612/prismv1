// Entry point of the prism-eslint image. Lints the repository mounted at the working directory
// with PRism's own configuration and prints one JSON document on stdout.
//
//   node /prism/run.mjs                 lint the whole repository
//   node /prism/run.mjs /job/files.json lint only the listed repository-relative files
//
// Exit code 0 means the lint ran to the end, whatever it found. Anything else is a failed scan.
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";

const cwd = process.cwd();
const listPath = process.argv[2];

let targets = ["."];
if (listPath) {
    const listed = JSON.parse(fs.readFileSync(listPath, "utf8"));
    if (!Array.isArray(listed) || listed.some(f => typeof f !== "string")) throw new Error("The file list is not an array of paths");
    // A listed file that is not in this tree (deleted, or added by the other commit) is simply not linted.
    targets = listed.filter(f => fs.existsSync(path.join(cwd, f)));
}

const eslint = new ESLint({
    cwd,
    overrideConfigFile: "/prism/eslint.config.mjs",
    errorOnUnmatchedPattern: false,
    warnIgnored: false,
    cache: false,
});

const results = targets.length > 0 ? await eslint.lintFiles(targets) : [];

process.stdout.write(JSON.stringify({
    tool: "eslint",
    version: ESLint.version,
    results: results.map(r => ({
        filePath: path.relative(cwd, r.filePath).split(path.sep).join("/"),
        messages: r.messages.map(m => ({
            ruleId: m.ruleId ?? null,
            severity: m.severity,
            message: m.message,
            line: m.line ?? null,
            column: m.column ?? null,
            endLine: m.endLine ?? null,
            endColumn: m.endColumn ?? null,
            fatal: m.fatal === true,
            fix: m.fix ? { range: m.fix.range, text: m.fix.text } : null,
            suggestionCount: Array.isArray(m.suggestions) ? m.suggestions.length : 0,
        })),
    })),
}));
