import Link from "next/link";

const TABS = [
    { key: "reviews", label: "Reviews", href: "/dashboard/reviews" },
    { key: "insights", label: "Insights", href: "/dashboard/reviews/insights" },
] as const;

/** Switches between the list of reviews and the quality numbers behind them. */
export function ReviewsNav({ active }: { active: (typeof TABS)[number]["key"] }) {
    return (
        <nav aria-label="Reviews sections" className="flex gap-1 border-b">
            {TABS.map(tab => (
                <Link
                    key={tab.key}
                    href={tab.href}
                    aria-current={tab.key === active ? "page" : undefined}
                    className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                        tab.key === active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                >
                    {tab.label}
                </Link>
            ))}
        </nav>
    );
}
