"use client";

import React from "react";
import dynamic from "next/dynamic";
const ActivityCalendar = dynamic(() => import("react-activity-calendar").then(mod => mod.ActivityCalendar), { ssr: false });
import { useTheme } from "next-themes";
import { getContributionStats } from "../actions";
import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/ui/spinner";
import { Empty, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

const calendarTheme = {
    light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    dark: ["#1e2228", "#0e4429", "#006d32", "#26a641", "#39d353"],
};

const ContributionGraph = () => {
    const { resolvedTheme } = useTheme();
    const currentTheme = resolvedTheme === "dark" ? "dark" : "light";

    const { data, isLoading } = useQuery({
        queryKey: ['contribution-graph'],
        queryFn: async () => await getContributionStats(),
        staleTime: 1000 * 60 * 5,
    })

    if (isLoading) {
        return (
            <div className="flex w-full items-center justify-center p-8 min-h-[160px]">
                <Spinner className="size-6 text-muted-foreground" />
            </div>
        )
    }

    if (!data || !data.contributions.length) {
        return (
            <Empty className="my-4">
                <EmptyTitle>No Contributions Found</EmptyTitle>
                <EmptyDescription>
                    We couldn&apos;t find any recent GitHub contributions.
                </EmptyDescription>
            </Empty>
        )
    }

    return (
        <div className="w-full flex flex-col items-center gap-3 py-2">
            <div className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">
                    {data.totalContributions}
                </span>{" "}
                contributions in the last year
            </div>

            <div className="w-full overflow-x-auto pb-2 flex justify-center">
                <div className="min-w-fit px-2">
                    <ActivityCalendar
                        data={data.contributions}
                        colorScheme={currentTheme}
                        blockSize={12}
                        blockMargin={3.5}
                        fontSize={12}
                        showWeekdayLabels
                        showMonthLabels
                        theme={calendarTheme}
                    />
                </div>
            </div>
        </div>
    )
}

export default ContributionGraph