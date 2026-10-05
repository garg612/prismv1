import { Octokit } from "octokit";
import { SuggestedFix, Patch, PullRequest, Repository } from "@/generated/prisma/client";
import { applyLiteralEdit } from "@/modules/fix/lib/diff";

export type DeliveryMode = "DIRECT_COMMIT" | "FIX_BRANCH_PR" | "SUGGESTION_COMMENT";

export async function checkBlobsMatch(
    octokit: Octokit,
    owner: string,
    repo: string,
    headSha: string,
    baseBlobShas: Record<string, string>
): Promise<boolean> {
    // 1. Get the tree for headSha
    const { data: tree } = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: headSha,
        recursive: "1",
    });

    const treeBlobs = new Map<string, string>();
    for (const item of tree.tree) {
        if (item.type === "blob" && item.path && item.sha) {
            treeBlobs.set(item.path, item.sha);
        }
    }

    // 2. Check if all base blobs match
    for (const [path, expectedSha] of Object.entries(baseBlobShas)) {
        const actualSha = treeBlobs.get(path);
        if (actualSha !== expectedSha) {
            return false;
        }
    }

    return true;
}

export async function applyFixToGithub(
    octokit: Octokit,
    mode: DeliveryMode,
    repository: Repository,
    pullRequest: PullRequest,
    fix: SuggestedFix,
    patch: Patch
): Promise<{ success: boolean; resultCommitSha?: string; resultBranch?: string; resultPrUrl?: string; error?: string; appliedMode?: DeliveryMode }> {
    try {
        const owner = repository.owner;
        const repo = repository.name;
        
        // Ensure blobs still match before doing anything
        if (patch.baseBlobShas) {
            const headOwner = pullRequest.headRepoFullName.split('/')[0] || owner;
            const headRepoName = pullRequest.headRepoFullName.split('/')[1] || repo;
            const blobsMatch = await checkBlobsMatch(octokit, headOwner, headRepoName, pullRequest.latestHeadSha, patch.baseBlobShas as Record<string, string>);
            if (!blobsMatch) {
                return { success: false, error: "BLOB_MISMATCH" };
            }
        }

        // Fork handling
        let appliedMode = mode;
        if (pullRequest.isFork && appliedMode !== "SUGGESTION_COMMENT") {
            appliedMode = "SUGGESTION_COMMENT"; // Fallback for forks
        }

        if (appliedMode === "DIRECT_COMMIT") {
            return await applyDirectCommit(octokit, owner, repo, pullRequest, fix, patch);
        } else if (appliedMode === "FIX_BRANCH_PR") {
            return await applyStackedPr(octokit, owner, repo, pullRequest, fix, patch);
        } else if (appliedMode === "SUGGESTION_COMMENT") {
            return await applySuggestion(octokit, owner, repo, pullRequest, fix, patch);
        }
        
        return { success: false, error: "UNSUPPORTED_MODE" };
    } catch (err: any) {
        console.error("Apply fix error:", err);
        return { success: false, error: err.message };
    }
}

/**
 * True when the file no longer has the text the edit looks for but does have the text it would
 * write: an earlier fix made this exact change. An edit that only deletes cannot be recognised
 * this way, so it stays a conflict.
 */
export function isAlreadyApplied(content: string, edit: { find: string; replace: string }): boolean {
    return !content.includes(edit.find) && edit.replace.trim().length > 0 && content.includes(edit.replace);
}

async function applyDirectCommit(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullRequest: PullRequest,
    fix: SuggestedFix,
    patch: Patch
) {
    const headSha = pullRequest.latestHeadSha;
    
    try {
        // 1. Get the current commit to find the tree
        const { data: commitData } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });
        
        // 2. Create blobs for the modified files
        const edits = fix.edits as any[];
        const treeItems = [];
        
        // Edits to the same file accumulate, so the second edit sees the first one's result.
        const pending = new Map<string, string>();
        for (const edit of edits) {
            let content = pending.get(edit.path);
            if (content === undefined) {
                const { data: fileData } = await octokit.rest.repos.getContent({ owner, repo, path: edit.path, ref: headSha });
                if (Array.isArray(fileData) || fileData.type !== "file") throw new Error("Invalid file path");
                content = Buffer.from((fileData as any).content, "base64").toString("utf-8");
            }
            if (!content.includes(edit.find)) {
                return { success: false, error: "FIX_CONFLICT" };
            }
            pending.set(edit.path, applyLiteralEdit(content, edit.find, edit.replace));
        }

        for (const [path, content] of pending) {
            const { data: blobData } = await octokit.rest.git.createBlob({
                owner,
                repo,
                content,
                encoding: "utf-8"
            });

            treeItems.push({
                path,
                mode: "100644" as const,
                type: "blob" as const,
                sha: blobData.sha
            });
        }
        
        // 3. Create a new tree
        const { data: treeData } = await octokit.rest.git.createTree({
            owner,
            repo,
            base_tree: commitData.tree.sha,
            tree: treeItems
        });
        
        // 4. Create the commit
        const message = `fix: resolve issue ${fix.findingId}\n\nCo-authored-by: PRism <bot@prism.local>`;
        const { data: newCommit } = await octokit.rest.git.createCommit({
            owner,
            repo,
            message,
            tree: treeData.sha,
            parents: [headSha]
        });
        
        // 5. Update the ref (NO FORCE PUSH)
        await octokit.rest.git.updateRef({
            owner,
            repo,
            ref: `heads/${pullRequest.headRef}`,
            sha: newCommit.sha,
            force: false
        });
        
        return {
            success: true,
            resultCommitSha: newCommit.sha,
            resultBranch: pullRequest.headRef,
            appliedMode: "DIRECT_COMMIT" as DeliveryMode
        };
    } catch (e: any) {
        if (e.status === 403 || e.status === 422 || e.message?.includes("Update is not a fast forward")) {
            // Permission or protection issue -> fallback to Stacked PR
            return await applyStackedPr(octokit, owner, repo, pullRequest, fix, patch);
        }
        throw e;
    }
}

async function applyStackedPr(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullRequest: PullRequest,
    fix: SuggestedFix,
    patch: Patch
) {
    const headSha = pullRequest.latestHeadSha;
    const shortSha = headSha.substring(0, 7);
    const branchName = `prism/fix/pr-${pullRequest.number}-${shortSha}`;
    
    // 1. Find the tip to build on. Fixes accepted for the same PR commit share one fix branch,
    //    so a later fix is committed on top of the earlier ones instead of beside them.
    let tipSha = headSha;
    let branchExists = false;
    try {
        const { data: existingRef } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branchName}` });
        tipSha = existingRef.object.sha;
        branchExists = true;
    } catch (e: any) {
        if (e.status !== 404) throw e;
    }

    const { data: commitData } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: tipSha });

    // 2. Create blobs and tree. The branch is only written once the commit exists.
    const edits = fix.edits as any[];
    const treeItems = [];
    // Edits to the same file accumulate, so the second edit sees the first one's result.
    const pending = new Map<string, string>();
    let alreadyApplied = 0;

    for (const edit of edits) {
        let content = pending.get(edit.path);
        if (content === undefined) {
            const { data: fileData } = await octokit.rest.repos.getContent({ owner, repo, path: edit.path, ref: tipSha });
            if (Array.isArray(fileData) || fileData.type !== "file") {
                return { success: false, error: "FIX_TARGET_MISSING" };
            }
            content = Buffer.from((fileData as any).content, "base64").toString("utf-8");
        }

        if (!content.includes(edit.find)) {
            // An earlier fix on this branch already rewrote the code this fix expects. When what it
            // left behind is exactly what this fix would write, the work is already done: two issues
            // on the same line often get the same fix. Anything else is a real conflict.
            if (branchExists && isAlreadyApplied(content, edit)) {
                alreadyApplied++;
                continue;
            }
            return { success: false, error: "FIX_CONFLICT" };
        }
        pending.set(edit.path, applyLiteralEdit(content, edit.find, edit.replace));
    }

    // Every edit of this fix is already on the fix branch: nothing to commit, and the fix is in place.
    if (pending.size === 0 && alreadyApplied > 0) {
        const { data: openPrs } = await octokit.rest.pulls.list({
            owner, repo, state: "open", head: `${owner}:${branchName}`, base: pullRequest.headRef
        });
        if (openPrs.length > 0) {
            await octokit.rest.pulls.update({
                owner, repo, pull_number: openPrs[0].number,
                body: `${openPrs[0].body || ""}\n- **Also fixes finding**: ${fix.findingId} (same change as an earlier fix)`
            });
        }
        return {
            success: true,
            resultCommitSha: tipSha,
            resultBranch: branchName,
            resultPrUrl: openPrs[0]?.html_url,
            appliedMode: "FIX_BRANCH_PR" as DeliveryMode
        };
    }

    for (const [path, content] of pending) {
        
        const { data: blobData } = await octokit.rest.git.createBlob({
            owner, repo, content, encoding: "utf-8"
        });
        
        treeItems.push({ path, mode: "100644" as const, type: "blob" as const, sha: blobData.sha });
    }

    const { data: treeData } = await octokit.rest.git.createTree({
        owner, repo, base_tree: commitData.tree.sha, tree: treeItems
    });

    // 4. Create the commit
    const message = `fix: resolve issue ${fix.findingId}\n\nCo-authored-by: PRism <bot@prism.local>`;
    const { data: newCommit } = await octokit.rest.git.createCommit({
        owner, repo, message, tree: treeData.sha, parents: [tipSha]
    });
    
    // 5. Point the branch at the new commit (NO FORCE PUSH)
    if (branchExists) {
        await octokit.rest.git.updateRef({
            owner, repo, ref: `heads/${branchName}`, sha: newCommit.sha, force: false
        });
    } else {
        await octokit.rest.git.createRef({
            owner, repo, ref: `refs/heads/${branchName}`, sha: newCommit.sha
        });
    }
    
    // 6. Reuse the fix PR that is already open for this branch, if there is one
    if (branchExists) {
        const { data: openPrs } = await octokit.rest.pulls.list({
            owner, repo, state: "open", head: `${owner}:${branchName}`, base: pullRequest.headRef
        });
        if (openPrs.length > 0) {
            const existing = openPrs[0];
            await octokit.rest.pulls.update({
                owner,
                repo,
                pull_number: existing.number,
                body: `${existing.body || ""}\n- **Also fixes finding**: ${fix.findingId}`
            });
            return {
                success: true,
                resultCommitSha: newCommit.sha,
                resultBranch: branchName,
                resultPrUrl: existing.html_url,
                appliedMode: "FIX_BRANCH_PR" as DeliveryMode
            };
        }
    }

    // 7. Create the PR
    const prBody = `This PR was automatically generated by PRism to fix a finding.

- **Finding**: ${fix.findingId}
- **Validated against**: ${headSha} (Static validation only)
- User approval triggered this operation.`;

    const { data: newPr } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: `PRism Fix: Resolve finding ${fix.findingId}`,
        head: branchName,
        base: pullRequest.headRef, // Targeting the original PR branch
        body: prBody
    });
    
    return {
        success: true,
        resultCommitSha: newCommit.sha,
        resultBranch: branchName,
        resultPrUrl: newPr.html_url,
        appliedMode: "FIX_BRANCH_PR" as DeliveryMode
    };
}

async function applySuggestion(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullRequest: PullRequest,
    fix: SuggestedFix,
    patch: Patch
) {
    const edits = fix.edits as any[];
    // Simplistic fallback: post a comment with the diff since suggestion comments can be tricky for multi-file/multi-line
    const commentBody = `PRism suggests the following fix for finding ${fix.findingId}:\n\n\`\`\`diff\n${patch.unifiedDiff}\n\`\`\``;
    
    const { data: comment } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullRequest.number,
        body: commentBody
    });
    
    return {
        success: true,
        resultPrUrl: comment.html_url,
        appliedMode: "SUGGESTION_COMMENT" as DeliveryMode
    };
}
