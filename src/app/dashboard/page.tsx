"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/authClient";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import {
  getDashboardStats,
  getMonthlyActivity,
  getGlobalMetricHistory,
} from "@/modules/dashboard/actions";

import ContributionGraph from "@/modules/dashboard/components/ContributionGraph";
import { ReviewHealthRadar } from "@/modules/dashboard/components/ReviewHealthRadar";
import { MonthlyActivityLineChart } from "@/modules/dashboard/components/MonthlyActivityLineChart";
import { GlobalTrustChart } from "@/modules/dashboard/components/GlobalTrustChart";

const MainPage = () => {
    const { data: session } = authClient.useSession();
    const userName = session?.user?.name || "there";

    const { data: stats, isLoading: isLoadingStats } = useQuery({
        queryKey: ["dashboard-stats"],
        queryFn: async () => await getDashboardStats(),
        refetchOnWindowFocus: false,
    });

    const { data: monthlyActivity, isLoading: isLoadingActivity } = useQuery({
        queryKey: ["monthly-activity"],
        queryFn: async () => await getMonthlyActivity(),
        refetchOnWindowFocus: false,
    });

    const { data: globalMetrics, isLoading: isLoadingGlobalMetrics } = useQuery({
        queryKey: ["global-metrics-history"],
        queryFn: async () => await getGlobalMetricHistory(),
        refetchOnWindowFocus: false,
    });

    return (
        <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto">
            <PageHeader 
                title={`Hello ${userName},`} 
                description="Overview of your coding activity and AI Reviews" 
            />
            
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <div className="lg:col-span-3 h-full min-h-[350px]">
                    <ReviewHealthRadar stats={stats || {} as any} isLoading={isLoadingStats} />
                </div>
                <div className="lg:col-span-4 h-full min-h-[350px]">
                    <MonthlyActivityLineChart data={monthlyActivity || []} isLoading={isLoadingActivity} />
                </div>
            </div>

            <div className="w-full">
                <GlobalTrustChart snapshots={globalMetrics || []} isLoading={isLoadingGlobalMetrics} />
            </div>

            <Card className="w-full overflow-hidden">
                <CardHeader>
                    <CardTitle>Contribution Activity</CardTitle>
                    <CardDescription>Track your GitHub contributions</CardDescription>
                </CardHeader>
                <CardContent className="pb-6 overflow-x-auto flex justify-center">
                    <ContributionGraph/>
                </CardContent>
            </Card>
        </div>
    );
};

export default MainPage;