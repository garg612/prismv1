"use client";

import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

interface MonthlyActivityLineChartProps {
  data: {
    name: string;
    commits: number;
    prs: number;
    reviews: number;
  }[];
  isLoading: boolean;
}

export function MonthlyActivityLineChart({ data, isLoading }: MonthlyActivityLineChartProps) {
  if (isLoading) {
    return (
      <Card className="h-full flex flex-col">
        <CardHeader>
          <CardTitle>Monthly Activity</CardTitle>
          <CardDescription>Track your monthly activity</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-[300px] flex items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // Vibrant colors for good visibility in both dark and light modes
  const colors = {
    commits: "#3b82f6", // blue-500
    prs: "#8b5cf6",     // violet-500
    reviews: "#10b981"  // emerald-500
  };

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle>Monthly Activity</CardTitle>
        <CardDescription>Track your monthly activity</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 min-h-[300px]">
        <ResponsiveContainer width="99%" height={300}>
          <LineChart data={data || []} margin={{ top: 15, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="4 4" vertical={false} stroke="currentColor" className="opacity-10" />
            <XAxis dataKey="name" tickLine={false} axisLine={false} className="text-xs text-muted-foreground font-medium" dy={10} />
            <YAxis tickLine={false} axisLine={false} className="text-xs text-muted-foreground font-medium" width={40} dx={-10} />
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--background))', color: 'hsl(var(--foreground))', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
              itemStyle={{ fontWeight: 500 }}
              cursor={{ stroke: 'currentColor', strokeWidth: 1, strokeDasharray: '4 4', opacity: 0.2 }}
            />
            <Legend wrapperStyle={{ fontSize: '13px', fontWeight: '500', paddingTop: '20px' }} iconType="circle" />
            <Line type="monotone" dataKey="commits" name="Contributions" stroke={colors.commits} strokeWidth={3} dot={{ r: 4, strokeWidth: 2, fill: "var(--background)", stroke: colors.commits }} activeDot={{ r: 6, strokeWidth: 0, fill: colors.commits }} />
            <Line type="monotone" dataKey="prs" name="Pull Requests" stroke={colors.prs} strokeWidth={3} dot={{ r: 4, strokeWidth: 2, fill: "var(--background)", stroke: colors.prs }} activeDot={{ r: 6, strokeWidth: 0, fill: colors.prs }} />
            <Line type="monotone" dataKey="reviews" name="AI Reviews" stroke={colors.reviews} strokeWidth={3} dot={{ r: 4, strokeWidth: 2, fill: "var(--background)", stroke: colors.reviews }} activeDot={{ r: 6, strokeWidth: 0, fill: colors.reviews }} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
