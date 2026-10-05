"use client";

import React from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

import {
  GitCommit,
  GitPullRequest,
  MessageSquare,
  GitBranch,
  CheckCircle2,
} from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import {
  getDashboardStats,
  getMonthlyActivity,
} from "@/modules/dashboard/actions";
import ContributionGraph from "@/modules/dashboard/components/ContributionGraph";
import { authClient } from "@/lib/authClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import { PageHeader } from "@/components/PageHeader";

const StatSkeleton = () => <Skeleton className="h-8 w-16 mt-1" />;

const MainPage=()=>{

    const {data:stats,isLoading}=useQuery({
        queryKey:["dashboard-stats"],
        queryFn:async()=>await getDashboardStats(),
        refetchOnWindowFocus:false,
    })

    const {data:monthyActivity,isLoading:isLoadingActivity}=useQuery({
        queryKey:["monthly-activity"],
        queryFn:async()=>await getMonthlyActivity(),
        refetchOnWindowFocus:false,
    })

    const { data: session } = authClient.useSession();
    const userName = session?.user?.name || "there";

    return(
        <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto">
            <PageHeader 
                title={`Hello ${userName},`} 
                description="Overview of your coding activity and AI Reviews" 
            />
            
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Reviews Analyzed</CardTitle>
                        <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoading ? <StatSkeleton /> : stats?.totalReviews || 0}
                        </div>
                        <p className="text-xs text-muted-foreground">pull requests scanned</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Findings Found</CardTitle>
                        <GitCommit className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoading ? <StatSkeleton /> : stats?.findingsAnalyzed || 0}
                        </div>
                        <p className="text-xs text-muted-foreground">total security issues</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Findings Surfaced</CardTitle>
                        <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-blue-600">
                            {isLoading ? <StatSkeleton /> : stats?.findingsSurfaced || 0}
                        </div>
                        <p className="text-xs text-muted-foreground">triaged by ML model</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Fixes Generated</CardTitle>
                        <GitBranch className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoading ? <StatSkeleton /> : stats?.fixesGenerated || 0}
                        </div>
                        <p className="text-xs text-muted-foreground">fixes proposed</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Fixes Ready</CardTitle>
                        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-green-600">
                            {isLoading ? <StatSkeleton /> : stats?.fixesReady || 0}
                        </div>
                        <p className="text-xs text-muted-foreground">passed validations</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Fixes Accepted</CardTitle>
                        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoading ? <StatSkeleton /> : stats?.fixesAccepted || 0}
                        </div>
                        <p className="text-xs text-muted-foreground">by developer</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Fixes Rejected</CardTitle>
                        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-red-600">
                            {isLoading ? <StatSkeleton /> : stats?.fixesRejected || 0}
                        </div>
                        <p className="text-xs text-muted-foreground">by developer</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Fixes Applied</CardTitle>
                        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoading ? <StatSkeleton /> : stats?.fixesApplied || 0}
                        </div>
                        <p className="text-xs text-muted-foreground">merged to GitHub</p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <Card className="lg:col-span-4 flex flex-col">
                    <CardHeader>
                        <CardTitle>Contribution Activity</CardTitle>
                        <CardDescription>Track your contributions</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 flex items-center justify-center">
                        <ContributionGraph/>
                    </CardContent>
                </Card>
                <Card className="lg:col-span-3 flex flex-col">
                    <CardHeader>
                        <CardTitle>Monthly Activity</CardTitle>
                        <CardDescription>Track your monthly activity</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-[300px]">
                        {isLoadingActivity ? (
                            <div className="h-full flex items-center justify-center">
                                <Spinner className="size-6 text-muted-foreground" />
                            </div>
                        ) : (
                            <ResponsiveContainer width="99%" height={300}>
                                <BarChart data={monthyActivity || []}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="opacity-10" />
                                    <XAxis dataKey="name" tickLine={false} axisLine={false} className="text-xs text-muted-foreground" />
                                    <YAxis tickLine={false} axisLine={false} className="text-xs text-muted-foreground" width={40} />
                                    <Tooltip 
                                        cursor={{ fill: 'currentColor', opacity: 0.1 }}
                                        contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Bar dataKey="commits" name="Contributions" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                                    <Bar dataKey="prs" name="Pull Requests" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                                    <Bar dataKey="reviews" name="AI Reviews" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}

export default MainPage