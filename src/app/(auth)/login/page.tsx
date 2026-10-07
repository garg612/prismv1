
export const instant = false;

import { Metadata } from "next";
import { requireUnAuth } from "@/modules/auth/utils/authUtils";
import { getAuthErrorMessage } from "@/modules/auth/utils/authErrors";
import LoginPage from "@/modules/auth/components/LoginPage";

export const metadata: Metadata = {
    title: "PRism — Code review that fixes what it finds",
    description: "PRism scans pull requests with Semgrep and ESLint, sets the noise aside, and proposes fixes tested in an isolated sandbox. You decide what gets applied. Sign in with GitHub to get started.",
    openGraph: {
        title: "PRism — Code review that fixes what it finds",
        description: "Pull request review with fixes that are checked before you see them.",
        type: "website",
    },
};

export default async function LoginRoute({
    searchParams,
}: {
    searchParams: Promise<{ error?: string }>;
}) {
    await requireUnAuth();
    const { error } = await searchParams;

    return (
        <main id="main-content" className="bg-background min-h-screen">
            <LoginPage authError={getAuthErrorMessage(error)} />
        </main>
    );
}
