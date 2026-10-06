import dotenv from "dotenv";
dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = "garg612/PRism-test-repo";

async function github(method: string, path: string, body?: any) {
    const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            "Authorization": `Bearer ${GITHUB_TOKEN}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
        throw new Error(`GitHub API Error: ${res.status} ${res.statusText} ${await res.text()}`);
    }
    return res.json();
}

async function createPR(branch: string, content: string, title: string) {
    console.log(`Creating PR ${title} on branch ${branch}...`);
    const mainRef = await github("GET", `/repos/${REPO}/git/ref/heads/main`);
    const mainSha = mainRef.object.sha;

    await github("POST", `/repos/${REPO}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: mainSha
    }).catch(e => console.log("Branch might already exist..."));

    const blob = await github("POST", `/repos/${REPO}/git/blobs`, {
        content,
        encoding: "utf-8"
    });

    const tree = await github("POST", `/repos/${REPO}/git/trees`, {
        base_tree: mainSha,
        tree: [{
            path: `test-${branch}.js`,
            mode: "100644",
            type: "blob",
            sha: blob.sha
        }]
    });

    const commit = await github("POST", `/repos/${REPO}/git/commits`, {
        message: title,
        tree: tree.sha,
        parents: [mainSha]
    });

    await github("PATCH", `/repos/${REPO}/git/refs/heads/${branch}`, {
        sha: commit.sha,
        force: true
    });

    const pr = await github("POST", `/repos/${REPO}/pulls`, {
        title,
        head: branch,
        base: "main"
    });

    console.log(`-> PR created: ${pr.html_url}`);
    return pr;
}

createPR("test-rule-7", "console.log('hello world'); eval('dangerous');", "Test PR 7 - Verify Surface Override").catch(console.error);
