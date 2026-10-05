"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-fetches the server-rendered page while the review is still changing. */
export function AutoRefresh({ active, intervalMs = 5000 }: { active: boolean; intervalMs?: number }) {
    const router = useRouter();

    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => router.refresh(), intervalMs);
        return () => clearInterval(timer);
    }, [active, intervalMs, router]);

    return null;
}
