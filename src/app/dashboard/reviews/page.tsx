import { Suspense } from "react";
import Link from "next/link";
import { GitPullRequest } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { requireAuth } from "@/modules/auth/utils/authUtils";
import { loadReviewList, REVIEW_LIST_LIMIT } from "@/modules/review/lib/load-review-list";
import { AutoRefresh } from "@/modules/review/components/AutoRefresh";
import { ReviewList } from "@/modules/review/components/ReviewList";
import { ReviewsNav } from "@/modules/review/components/ReviewsNav";

function ListSkeleton() {
    return (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading reviews">
            <div className="h-8 w-80 max-w-full animate-pulse rounded-full bg-muted" />
            {[0, 1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />)}
        </div>
    );
}

async function Reviews() {
    const session = await requireAuth();
    const { items, truncated } = await loadReviewList(session.user.id);

    if (items.length === 0) {
        return (
            <Empty className="my-8">
                <GitPullRequest className="mb-4 size-10 text-muted-foreground/40" aria-hidden />
                <EmptyTitle>No reviews yet</EmptyTitle>
                <EmptyDescription>
                    PRism reviews a pull request as soon as it is opened or updated in a connected repository.
                </EmptyDescription>
                <Button asChild variant="outline" className="mt-4">
                    <Link href="/dashboard/repository">Connect a repository</Link>
                </Button>
            </Empty>
        );
    }

    return (
        <>
            <AutoRefresh active={items.some(item => item.group === "progress")} intervalMs={8000} />
            <ReviewList items={items} />
            {truncated && (
                <p className="text-center text-xs text-muted-foreground">
                    Showing the {REVIEW_LIST_LIMIT} most recently updated reviews.
                </p>
            )}
        </>
    );
}

export default function ReviewsPage() {
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <PageHeader title="Reviews" description="One row per pull request: what was found, what was fixed and what is still open." />
            <ReviewsNav active="reviews" />
            <Suspense fallback={<ListSkeleton />}>
                <Reviews />
            </Suspense>
        </div>
    );
}
