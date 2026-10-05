import {auth} from "@/lib/auth"
import {headers} from "next/headers"
import {redirect} from "next/navigation"

export const requireAuth = async () => {
    let session;
    try {
        const headersList = await headers();
        session = await auth.api.getSession({
            headers: headersList
        });
    } catch (err: any) {
        // Do not catch Next.js redirect or dynamic server errors
        if (err && err.digest && (err.digest.startsWith('NEXT_REDIRECT') || err.digest === 'DYNAMIC_SERVER_USAGE' || err.digest === 'HANGING_PROMISE_REJECTION')) {
            throw err;
        }
        console.error("[requireAuth] Failed to get session:", err);
        session = null;
    }

    if (!session) {
        redirect("/login");
    }

    return session;
}

export const requireUnAuth = async () => {
    let session;
    try {
        const headersList = await headers();
        session = await auth.api.getSession({
            headers: headersList
        });
    } catch (err: any) {
        if (err && err.digest && (err.digest.startsWith('NEXT_REDIRECT') || err.digest === 'DYNAMIC_SERVER_USAGE' || err.digest === 'HANGING_PROMISE_REJECTION')) {
            throw err;
        }
        console.error("[requireUnAuth] Failed to get session:", err);
        session = null;
    }

    if (session) {
        redirect("/");
    }

    return session;
}