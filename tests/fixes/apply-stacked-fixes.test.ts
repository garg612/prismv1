import { describe, expect, it } from "vitest";
import { applyFixToGithub, isAlreadyApplied } from "../../src/modules/github/lib/apply-fix";
import { fixErrorMessage } from "../../src/modules/review/lib/fix-errors";

const HEAD = "7286509aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BRANCH = "prism/fix/pr-50-7286509";

const USERS = `function getUser(id) {
    return db.query("SELECT * FROM users WHERE id = " + id);
}
function getUserByEmail(email) {
    return db.query("SELECT * FROM users WHERE email = '" + email + "'");
}
`;

/** In-memory stand-in for the GitHub git data API: commits hold a file map, refs point at commits. */
function fakeGithub() {
    const commits = new Map<string, { files: Record<string, string>; parents: string[] }>();
    const trees = new Map<string, Record<string, string>>();
    const blobs = new Map<string, string>();
    const refs = new Map<string, string>();
    const prs: any[] = [];
    let seq = 0;

    commits.set(HEAD, { files: { "lib/users.js": USERS, "lib/orders.js": 'db.query("SELECT 1 WHERE a = " + a);\n' }, parents: [] });
    trees.set(`tree-${HEAD}`, commits.get(HEAD)!.files);

    const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

    const octokit = {
        rest: {
            git: {
                getRef: async ({ ref }: any) => {
                    const sha = refs.get(ref.replace(/^heads\//, ""));
                    if (!sha) throw notFound();
                    return { data: { object: { sha } } };
                },
                getCommit: async ({ commit_sha }: any) => ({ data: { tree: { sha: `tree-${commit_sha}` } } }),
                createBlob: async ({ content }: any) => {
                    const sha = `blob-${++seq}`;
                    blobs.set(sha, content);
                    return { data: { sha } };
                },
                createTree: async ({ base_tree, tree }: any) => {
                    const files = { ...trees.get(base_tree)! };
                    for (const item of tree) files[item.path] = blobs.get(item.sha)!;
                    const sha = `tree-new-${++seq}`;
                    trees.set(sha, files);
                    return { data: { sha } };
                },
                createCommit: async ({ tree, parents }: any) => {
                    const sha = `commit-${++seq}`;
                    commits.set(sha, { files: trees.get(tree)!, parents });
                    trees.set(`tree-${sha}`, trees.get(tree)!);
                    return { data: { sha } };
                },
                createRef: async ({ ref, sha }: any) => {
                    const name = ref.replace(/^refs\/heads\//, "");
                    if (refs.has(name)) throw Object.assign(new Error("Reference already exists"), { status: 422 });
                    refs.set(name, sha);
                    return { data: {} };
                },
                updateRef: async ({ ref, sha }: any) => {
                    const name = ref.replace(/^heads\//, "");
                    // A real non-forced update is refused unless the new commit descends from the current tip.
                    if (!commits.get(sha)!.parents.includes(refs.get(name)!)) {
                        throw Object.assign(new Error("Update is not a fast forward"), { status: 422 });
                    }
                    refs.set(name, sha);
                    return { data: {} };
                }
            },
            repos: {
                getContent: async ({ path, ref }: any) => {
                    const content = commits.get(ref)?.files[path];
                    if (content === undefined) throw notFound();
                    return { data: { type: "file", content: Buffer.from(content).toString("base64") } };
                }
            },
            pulls: {
                list: async ({ head }: any) => ({ data: prs.filter(p => p.state === "open" && `garg612:${p.head}` === head) }),
                create: async ({ head, base, body }: any) => {
                    const pr = { number: 51 + prs.length, state: "open", head, base, body, html_url: `https://github.test/pull/${51 + prs.length}` };
                    prs.push(pr);
                    return { data: pr };
                },
                update: async ({ pull_number, body }: any) => {
                    prs.find(p => p.number === pull_number).body = body;
                    return { data: {} };
                }
            }
        }
    };

    return { octokit: octokit as any, refs, commits, prs };
}

const repository = { owner: "garg612", name: "demo1" } as any;
const pullRequest = { number: 50, latestHeadSha: HEAD, headRef: "feature", headRepoFullName: "garg612/demo1", isFork: false } as any;
const patch = { baseBlobShas: null, unifiedDiff: "" } as any;

const fixId = {
    findingId: "finding-id",
    edits: [{ path: "lib/users.js", find: '"SELECT * FROM users WHERE id = " + id', replace: '"SELECT * FROM users WHERE id = ?", [id]' }]
} as any;
const fixEmail = {
    findingId: "finding-email",
    edits: [{ path: "lib/users.js", find: `"SELECT * FROM users WHERE email = '" + email + "'"`, replace: '"SELECT * FROM users WHERE email = ?", [email]' }]
} as any;
const fixOrders = {
    findingId: "finding-orders",
    edits: [{ path: "lib/orders.js", find: '"SELECT 1 WHERE a = " + a', replace: '"SELECT 1 WHERE a = ?", [a]' }]
} as any;

describe("accepting several fixes for the same PR commit", () => {
    it("stacks each fix on the shared fix branch and reuses one fix PR", async () => {
        const gh = fakeGithub();

        const first = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, fixId, patch);
        const second = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, fixEmail, patch);
        const third = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, fixOrders, patch);

        expect([first.success, second.success, third.success]).toEqual([true, true, true]);
        expect(gh.prs).toHaveLength(1);
        expect(second.resultPrUrl).toBe(first.resultPrUrl);
        expect(third.resultPrUrl).toBe(first.resultPrUrl);
        expect(gh.prs[0].body).toContain("finding-email");
        expect(gh.prs[0].body).toContain("finding-orders");

        const tip = gh.commits.get(gh.refs.get(BRANCH)!)!;
        expect(tip.files["lib/users.js"]).toContain('WHERE id = ?", [id]');
        expect(tip.files["lib/users.js"]).toContain('WHERE email = ?", [email]');
        expect(tip.files["lib/orders.js"]).toContain('WHERE a = ?", [a]');
        expect(tip.files["lib/users.js"]).not.toContain('" + id');
    });

    it("treats a second fix that makes the very same change as already done (two issues on one line)", async () => {
        const gh = fakeGithub();
        const first = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, fixId, patch);
        const tipBefore = gh.refs.get(BRANCH);

        const again = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, { ...fixId, findingId: "same-line-other-rule" }, patch);

        expect(again.success).toBe(true);
        expect(again.resultPrUrl).toBe(first.resultPrUrl);
        // nothing new was committed, and no second fix PR was opened
        expect(gh.refs.get(BRANCH)).toBe(tipBefore);
        expect(again.resultCommitSha).toBe(tipBefore);
        expect(gh.prs).toHaveLength(1);
        expect(gh.prs[0].body).toContain("same-line-other-rule");
    });

    it("refuses a fix that wants a different change to code an earlier fix already rewrote", async () => {
        const gh = fakeGithub();
        await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, fixId, patch);
        const tipBefore = gh.refs.get(BRANCH);
        const different = { findingId: "other", edits: [{ path: "lib/users.js", find: fixId.edits[0].find, replace: '"SELECT * FROM users WHERE id = $1", [id]' }] } as any;

        const result = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, different, patch);

        expect(result).toEqual({ success: false, error: "FIX_CONFLICT" });
        expect(gh.refs.get(BRANCH)).toBe(tipBefore);
        expect(gh.prs).toHaveLength(1);
    });

    it("applies the part of a fix that is still needed when another part is already in place", async () => {
        const gh = fakeGithub();
        await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, fixId, patch);
        const both = { findingId: "both", edits: [...fixId.edits, ...fixEmail.edits] } as any;

        const result = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, both, patch);

        expect(result.success).toBe(true);
        const file = gh.commits.get(gh.refs.get(BRANCH)!)!.files["lib/users.js"];
        expect(file).toContain('WHERE id = ?", [id]');
        expect(file).toContain('WHERE email = ?", [email]');
    });

    it("does not create a branch when the first fix cannot be applied", async () => {
        const gh = fakeGithub();
        const missing = { findingId: "x", edits: [{ path: "lib/users.js", find: "not in the file", replace: "y" }] } as any;

        const result = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, missing, patch);

        expect(result).toEqual({ success: false, error: "FIX_CONFLICT" });
        expect(gh.refs.has(BRANCH)).toBe(false);
        expect(gh.prs).toHaveLength(0);
    });
});

describe("a fix with several edits in one file", () => {
    const twoEdits = {
        findingId: "finding-both",
        edits: [...fixId.edits, ...fixEmail.edits]
    } as any;

    it("keeps every edit when delivered as a fix PR", async () => {
        const gh = fakeGithub();
        const result = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, twoEdits, patch);

        expect(result.success).toBe(true);
        const file = gh.commits.get(gh.refs.get(BRANCH)!)!.files["lib/users.js"];
        expect(file).toContain('WHERE id = ?", [id]');
        expect(file).toContain('WHERE email = ?", [email]');
    });

    it("keeps every edit when committed directly to the PR branch", async () => {
        const gh = fakeGithub();
        gh.refs.set("feature", HEAD);
        const result = await applyFixToGithub(gh.octokit, "DIRECT_COMMIT", repository, pullRequest, twoEdits, patch);

        expect(result.success).toBe(true);
        const file = gh.commits.get(gh.refs.get("feature")!)!.files["lib/users.js"];
        expect(file).toContain('WHERE id = ?", [id]');
        expect(file).toContain('WHERE email = ?", [email]');
    });
});

describe("recognising a change that is already in place", () => {
    const edit = { find: 'if (order.status = "paid") {', replace: 'if (order.status === "paid") {' };

    it("needs the old text gone and the new text present", () => {
        expect(isAlreadyApplied('if (order.status === "paid") {\n', edit)).toBe(true);
        expect(isAlreadyApplied('if (order.status = "paid") {\n', edit)).toBe(false);          // not applied yet
        expect(isAlreadyApplied('if (order.paid) {\n', edit)).toBe(false);                      // rewritten differently
    });

    it("never assumes a deletion was applied: there is nothing left to recognise it by", () => {
        expect(isAlreadyApplied("return true;\n", { find: "debugger;", replace: "" })).toBe(false);
        expect(isAlreadyApplied("return true;\n", { find: "debugger;", replace: "   " })).toBe(false);
    });

    it("is not used for the first fix on a commit: without an earlier fix a missing target is a conflict", async () => {
        const gh = fakeGithub();
        // The file already contains the replacement text, but no fix branch exists yet.
        const odd = { findingId: "x", edits: [{ path: "lib/users.js", find: "not in the file", replace: "function getUser(id) {" }] } as any;
        const result = await applyFixToGithub(gh.octokit, "FIX_BRANCH_PR", repository, pullRequest, odd, patch);
        expect(result).toEqual({ success: false, error: "FIX_CONFLICT" });
        expect(gh.refs.has(BRANCH)).toBe(false);
    });
});

describe("what the person is told when a fix action fails", () => {
    it("explains every code the actions return, in a sentence", () => {
        for (const code of ["FIX_CONFLICT", "FIX_TARGET_MISSING", "BLOB_MISMATCH", "FIX_ALREADY_PROCESSING", "FIX_NOT_READY", "FIX_NOT_FOUND", "INVALID_REVIEW_STATE", "MISSING_REPORT", "UNAUTHORIZED", "FORBIDDEN", "UNSUPPORTED_MODE", "NO_READY_FIXES", "NO_GITHUB_LINK"]) {
            const text = fixErrorMessage(code);
            expect(text).not.toContain(code);
            expect(text).toMatch(/^[A-Z].*\.$/);
        }
        expect(fixErrorMessage("FIX_CONFLICT")).toMatch(/Another fix you already applied changed the same lines/);
    });

    it("never shows a bare code, even one it does not know", () => {
        expect(fixErrorMessage("SOME_NEW_CODE")).toBe("The change could not be made (SOME_NEW_CODE). Nothing was changed.");
        expect(fixErrorMessage("")).toBe("Something went wrong. Nothing was changed.");
        expect(fixErrorMessage(undefined)).toBe("Something went wrong. Nothing was changed.");
    });

    it("passes on text that is already a sentence", () => {
        expect(fixErrorMessage("Too many requests. Try again in a minute.")).toBe("Too many requests. Try again in a minute.");
    });
});
