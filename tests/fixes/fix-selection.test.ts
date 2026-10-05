import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { DEFAULT_MAX_FIXES_PER_RUN, maxFixesPerRun, selectFindingsForFix } from "../../src/modules/fix/lib/selection";

const finding = (id: string, over: Partial<{ source: string; severity: string; filePath: string; startLine: number }> = {}) => ({
    id, source: "ESLINT", severity: "MEDIUM", filePath: "lib/a.js", startLine: 1, ...over,
});

describe("which shown findings of a review get a fix", () => {
    it("fixes every shown finding of an ordinary pull request in one review", () => {
        // The pull request that needed two reviews: six ESLint issues and one Semgrep issue.
        const seven = [
            ...Array.from({ length: 6 }, (_, i) => finding(`e${i}`, { startLine: i + 1 })),
            finding("s0", { source: "SEMGREP", severity: "HIGH", filePath: "lib/users.js" }),
        ];
        expect(selectFindingsForFix(seven)).toHaveLength(7);
    });

    it("does not leave findings behind at the old limit of five", () => {
        const twelve = Array.from({ length: 12 }, (_, i) => finding(`f${i}`, { startLine: i }));
        expect(selectFindingsForFix(twelve)).toHaveLength(12);
        expect(DEFAULT_MAX_FIXES_PER_RUN).toBeGreaterThanOrEqual(20);
    });

    it("keeps the most severe findings when a pull request exceeds the limit", () => {
        const many = [
            ...Array.from({ length: 30 }, (_, i) => finding(`low${i}`, { severity: "LOW", startLine: i })),
            finding("crit", { severity: "CRITICAL" }),
            finding("high", { severity: "HIGH" }),
        ];
        const chosen = selectFindingsForFix(many, 5);
        expect(chosen).toHaveLength(5);
        expect(chosen.slice(0, 2).map(f => f.id)).toEqual(["crit", "high"]);
    });

    it("chooses the same findings whatever order the database returned them in", () => {
        const rows = [
            finding("b", { filePath: "lib/b.js", startLine: 9 }),
            finding("a2", { filePath: "lib/a.js", startLine: 20 }),
            finding("a1", { filePath: "lib/a.js", startLine: 3 }),
            finding("h", { severity: "HIGH", filePath: "lib/z.js" }),
        ];
        const forward = selectFindingsForFix(rows, 3).map(f => f.id);
        const backward = selectFindingsForFix([...rows].reverse(), 3).map(f => f.id);
        expect(forward).toEqual(["h", "a1", "a2"]);
        expect(backward).toEqual(forward);
    });

    it("never fixes an AI suggestion", () => {
        const rows = [finding("logic", { source: "CUSTOM", severity: "CRITICAL" }), finding("real")];
        expect(selectFindingsForFix(rows).map(f => f.id)).toEqual(["real"]);
    });

    it("does not change the list it was given", () => {
        const rows = [finding("z", { startLine: 9 }), finding("a", { startLine: 1 })];
        selectFindingsForFix(rows);
        expect(rows.map(f => f.id)).toEqual(["z", "a"]);
    });
});

describe("the limit setting", () => {
    it("uses the default when the setting is absent or not a positive number", () => {
        for (const raw of [undefined, "", "abc", "0", "-3"]) expect(maxFixesPerRun(raw)).toBe(DEFAULT_MAX_FIXES_PER_RUN);
    });

    it("uses the setting when it is a positive number", () => {
        expect(maxFixesPerRun("40")).toBe(40);
        expect(maxFixesPerRun("3")).toBe(3);
    });
});

describe("how the pipeline uses it", () => {
    const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "../../src/inngest/functions", file), "utf8");

    it("the review asks for a fix for the selected findings, with no other cut", () => {
        const src = read("review-run.ts");
        expect(src).toContain("selectFindingsForFix(surfacedFindings");
        expect(src).not.toMatch(/surfacedFindings\.slice\(/);
    });

    it("the load is limited by how many fixes are worked on at once", () => {
        expect(read("process-finding.ts")).toMatch(/id: "process-finding", concurrency: \{ limit: 5 \}/);
    });
});
