import { Octokit } from "octokit"
import { auth } from "@/lib/auth"
import prisma from "@/lib/db"
import { headers } from "next/headers"

export const getGithubToken = async () => {
    try {
        if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
            return "demo_token";
        }
        const session = await auth.api.getSession({
            headers: await headers()
        })
        if (!session) {
            throw new Error("No valid session found")
        }
        const account = await prisma.account.findFirst({
            where: {
                userId: session.user.id,
                providerId: "github"
            }
        })
        if (!account) {
            throw new Error("No github account found")
        }
        if (!account.accessToken) {
            throw new Error("No github access token found")
        }

        // GitHub App tokens expire — detect early instead of getting a cryptic 401
        if (account.accessTokenExpiresAt && new Date(account.accessTokenExpiresAt) < new Date()) {
            console.error("[getGithubToken] GitHub access token has expired. User needs to re-authenticate.");
            throw new Error("GitHub access token has expired — user needs to re-authenticate")
        }

        return account.accessToken
    } catch (err) {
        console.log(err)
        throw new Error("Failed to fetch github token")
    }
}

export async function fetchUserContribution(token: string, username: string) {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
        const weeks = [];
        const now = new Date();
        for (let w = 0; w < 52; w++) {
            const days = [];
            for (let d = 0; d < 7; d++) {
                const date = new Date(now);
                date.setDate(now.getDate() - (52 - w) * 7 - (6 - d));
                days.push({
                    contributionCount: Math.floor(Math.random() * 5),
                    date: date.toISOString().split('T')[0],
                    color: "#216e39"
                });
            }
            weeks.push({ contributionDays: days });
        }
        return {
            totalContributions: 842,
            weeks
        };
    }

    const octokit = new Octokit({
        auth: token
    })

    const query = `
        query($username: String!) {
            user(login: $username) {
            contributionsCollection {
                contributionCalendar {
                totalContributions
                weeks {
                    contributionDays {
                        contributionCount
                        date
                        color
                        }
                    }
                }
            }
        }
    }`;

    // interface contributionData{
    //     user:{
    //         contributionCollection:{
    //             contributionCalendar:{
    //                 totalContributions:number,
    //                 weeks:{
    //                     contributionCount:number,
    //                     date:string | Date,
    //                     color:string
    //                 }
    //             }
    //         }
    //     }
    // }

    try {
         
        const res: any = await octokit.graphql(query, { username })
        return res.user.contributionsCollection.contributionCalendar
    } catch (err) {
        console.log(err)
        throw new Error("Failed to fetch user contribution")
    }
}

export const getRepositories = async (page: number = 1, perPage: number = 10) => {
    try {
        if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
            const dbRepos = await prisma.repository.findMany({
                take: perPage,
                skip: (page - 1) * perPage,
                orderBy: { updatedAt: 'desc' }
            });
            return dbRepos.map(r => ({
                id: Number(r.githubId),
                name: r.name,
                full_name: r.fullName,
                description: r.description,
                html_url: r.url,
                language: r.language,
                stargazers_count: Math.floor(Math.random() * 1000),
                topics: ["demo", "prism", "typescript"]
            }));
        }

        const token = await getGithubToken();
        const octokit = new Octokit({ auth: token });

        const { data } = await octokit.rest.repos.listForAuthenticatedUser({
            per_page: perPage,
            page: page,
            type: "owner",
            sort: "updated",
            direction: "desc",
        });
        return data;
    } catch (err) {
        console.log(err);
        throw new Error("Failed to fetch repositories");
    }
}

export const createWebhook = async (owner: string, repo: string) => {
    const token = await getGithubToken()
    const octokit = new Octokit({
        auth: token
    });
    const webhookURL = `${process.env.NEXT_PUBLIC_APP_BASE_URL}/api/webhooks/github`;
    const { data: hooks } = await octokit.rest.repos.listWebhooks({
        owner,
        repo,
    })
    const existingHook = hooks.find(hook => hook.config.url === webhookURL);
    if (existingHook) {
        console.log("Webhook already exists")
        return existingHook;
    }
    const { data } = await octokit.rest.repos.createWebhook({
        owner,
        repo,
        config: {
            url: webhookURL,
            content_type: "json",
            secret: process.env.GITHUB_WEBHOOK_SECRET,
        },
        events: ["push", "pull_request"],
        active: true
    })
    return data;
}

export const deleteWebhook = async (owner: string, repo: string) => {
    const token = await getGithubToken();
    const octokit = new Octokit({
        auth: token
    });
    const webhookURL = `${process.env.NEXT_PUBLIC_APP_BASE_URL}/api/webhooks/github`;
    try {
        const { data: hooks } = await octokit.rest.repos.listWebhooks({
            owner,
            repo,
        })
        const existingHook = hooks.find(hook => hook.config.url === webhookURL);
        if (existingHook) {
            await octokit.rest.repos.deleteWebhook({
                owner,
                repo,
                hook_id: existingHook.id
            })
        }
        return { success: true }
    } catch (err) {
        console.log(err);
        throw new Error("Failed to delete webhook");
    }
}

export async function getRepoFileContents(
    token: string,
    owner: string,
    repo: string,
    ref: string = "",
    path: string = ""
): Promise<{ path: string, content: string }[]> {
    const octokit = new Octokit({
        auth: token
    });
    try {
        const { data: file } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ...(ref ? { ref } : {})
        });
        if (!Array.isArray(file)) {
            if (file.type === "file" && "content" in file && typeof file.content === 'string') {
                return [{
                    path: file.path,
                    content: Buffer.from(file.content, "base64").toString("utf-8")
                }]
            }
            return []
        }
        let files: { path: string, content: string }[] = [];
        for (const item of file) {
            if (item.type === "file") {
                const { data: fileData } = await octokit.rest.repos.getContent({
                    owner,
                    repo,
                    path: item.path,
                    ...(ref ? { ref } : {})
                })
                if (!Array.isArray(fileData) && fileData.type === "file" && "content" in fileData && typeof fileData.content === 'string') {
                    // Filter out non-code files if needed (images, etc.)
                    // For now, let’s include everything that looks like text
                    if (!item.path.match(/\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|tar|gz)$/i)) {
                        files.push({
                            path: item.path,
                            content: Buffer.from(fileData.content, "base64").toString("utf-8"),
                        });
                    }
                }
            }else if(item.type === "dir"){
                const subFiles=await getRepoFileContents(
                    token,
                    owner,
                    repo,
                    ref,
                    item.path
                )
                files=files.concat(subFiles);
            }
        }
        return files;
    } catch (err) {
        console.error(err);
        throw err;
    }
}

/** Raw content of one file at an exact commit. Throws if the path is not a file at that ref. */
export async function getFileAtRef(token: string, owner: string, repo: string, path: string, ref: string): Promise<string> {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
        mediaType: { format: "raw" }
    });
    if (typeof data !== "string") {
        throw new Error(`${path}@${ref} is not a regular file`);
    }
    return data;
}

export async function getDiff(token:string,owner:string,repo:string,prNumber:number){
    const octokit =new Octokit({auth:token})
    const {data:pr}=await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number:prNumber
    })
    const {data:diff}=await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number:prNumber,
        mediaType:{
            format:"diff"
        }
    })
    return{
        diff:diff as unknown as string,
        title:pr.title,
        description:pr.body || "",
    }
}

export async function postReviewComment(token:string,owner:string,repo:string,prNumber:number,review:string){
    const octokit =new Octokit({auth:token})
    await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number:prNumber,
        body:`PRism Code Review \n\n ${review}\n\n---\n make better changes`
    })
}

export async function upsertReviewComment(token: string, owner: string, repo: string, prNumber: number, review: string) {
    const octokit = new Octokit({ auth: token });
    const marker = "<!-- PRISM_REVIEW_MARKER -->";
    const body = `PRism Code Review\n\n${review}\n\n---\n*Automated review by PRism*\n${marker}`;

    const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber
    });

    const existingComment = comments.find(c => c.body?.includes(marker));

    if (existingComment) {
        await octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: existingComment.id,
            body
        });
    } else {
        await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body
        });
    }
}

export async function getTarballUrl(token: string, owner: string, repo: string, ref: string): Promise<string> {
    const octokit = new Octokit({ auth: token });
    // This generates a temporary (usually 5-minute) download URL for the archive
    const { url } = await octokit.rest.repos.downloadTarballArchive({
        owner,
        repo,
        ref,
        method: 'HEAD', // We only want the redirect URL, though octokit might just return it
    });
    return url;
}

export async function listChangedFiles(token: string, owner: string, repo: string, prNumber: number): Promise<string[]> {
    const octokit = new Octokit({ auth: token });
    const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
    });
    // Return all files that are added or modified, filter out deleted ones
    return files.filter(f => f.status !== 'removed').map(f => f.filename);
}

export async function getFileCommitsSince(token: string, owner: string, repo: string, path: string, since: string) {
    const octokit = new Octokit({ auth: token });
    try {
        const response = await octokit.rest.repos.listCommits({
            owner,
            repo,
            path,
            since,
            per_page: 100
        });
        return response.data;
    } catch (e) {
        return [];
    }
}

// ---- Stage 5: Git Tree / Blob helpers ----

export interface TreeEntry {
    path: string;
    sha: string;
    size: number;
    type: 'blob' | 'tree';
}

export async function getDefaultBranchSha(token: string, owner: string, repo: string): Promise<{ sha: string; branch: string }> {
    const octokit = new Octokit({ auth: token });
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const branch = repoData.default_branch;
    const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch });
    return { sha: branchData.commit.sha, branch };
}

export async function getRepoTree(token: string, owner: string, repo: string, treeSha: string): Promise<TreeEntry[]> {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: '1' });
    return (data.tree ?? []).filter(e => e.type === 'blob' && e.path && e.sha).map(e => ({ path: e.path!, sha: e.sha!, size: e.size ?? 0, type: 'blob' as const }));
}

export async function getBlob(token: string, owner: string, repo: string, blobSha: string): Promise<string | null> {
    const octokit = new Octokit({ auth: token });
    try {
        const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: blobSha });
        if (data.encoding === 'base64') return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
        if (data.encoding === 'utf-8') return data.content;
        return null;
    } catch { return null; }
}

export async function getChangedFiles(token: string, owner: string, repo: string, baseSha: string, headSha: string): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
    const octokit = new Octokit({ auth: token });
    try {
        const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base: baseSha, head: headSha, per_page: 300 });
        const added: string[] = [], modified: string[] = [], removed: string[] = [];
        for (const file of data.files ?? []) {
            if (!file.filename) continue;
            if (file.status === 'added') added.push(file.filename);
            else if (['modified', 'renamed', 'changed'].includes(file.status ?? '')) modified.push(file.filename);
            else if (file.status === 'removed') removed.push(file.filename);
        }
        return { added, modified, removed };
    } catch { return { added: [], modified: [], removed: [] }; }
}
