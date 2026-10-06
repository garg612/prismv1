import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) throw new Error("No GITHUB_TOKEN");

async function main() {
    const res = await fetch("https://api.github.com/user/repos", {
        headers: { "Authorization": `Bearer ${GITHUB_TOKEN}`, "Accept": "application/vnd.github.v3+json" }
    });
    const repos = await res.json();
    console.log(repos.map((r: any) => r.full_name).join("\n"));
}

main().catch(console.error);
