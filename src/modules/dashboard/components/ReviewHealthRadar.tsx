"use client";

import React from "react";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface ReviewHealthRadarProps {
  stats: {
    totalReviews: number;
    findingsAnalyzed: number;
    findingsSurfaced: number;
    fixesGenerated: number;
    fixesReady: number;
    fixesAccepted: number;
    fixesRejected: number;
    fixesApplied: number;
    totalPRs?: number;
  };
  isLoading: boolean;
}

export function ReviewHealthRadar({ stats, isLoading }: ReviewHealthRadarProps) {
  if (isLoading) {
    return (
      <Card className="h-full flex flex-col">
        <CardHeader>
          <CardTitle>Review Health</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[300px]">
          <Skeleton className="w-[250px] h-[250px] rounded-full" />
        </CardContent>
      </Card>
    );
  }

  const hasData = stats.totalReviews > 0 || stats.findingsAnalyzed > 0;

  if (!hasData) {
    return (
      <Card className="h-full flex flex-col">
        <CardHeader>
          <CardTitle>Review Health</CardTitle>
          <CardDescription>Overview of your review metrics</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
          No data available yet
        </CardContent>
      </Card>
    );
  }

  // Safe percentage helper
  const safePercent = (num: number, den: number, fallbackWhenZeroDen = 0) =>
    den > 0 ? Math.round((num / den) * 100) : fallbackWhenZeroDen;

  const totalPRs = stats.totalPRs || stats.totalReviews || 1;
  const isCleanReviews = stats.totalReviews > 0 && stats.findingsSurfaced === 0;

  const data = [
    {
      subject: "Coverage",
      value: safePercent(stats.totalReviews, totalPRs),
      rawText: `${stats.totalReviews} reviewed / ${totalPRs} total PRs`,
    },
    {
      subject: "Noise Reduction",
      value: stats.findingsAnalyzed > 0 
        ? 100 - safePercent(stats.findingsSurfaced, stats.findingsAnalyzed)
        : 100,
      rawText: `${Math.max(0, stats.findingsAnalyzed - stats.findingsSurfaced)} filtered / ${stats.findingsAnalyzed} raw alerts`,
    },
    {
      subject: "Autofix Capability",
      value: isCleanReviews ? 100 : safePercent(stats.fixesGenerated, stats.findingsSurfaced),
      rawText: isCleanReviews 
        ? "100% (No defects requiring fix)"
        : `${stats.fixesGenerated} fixes generated / ${stats.findingsSurfaced} surfaced issues`,
    },
    {
      subject: "Fix Adoption",
      value: (stats.fixesAccepted + stats.fixesRejected) > 0
        ? safePercent(stats.fixesAccepted, stats.fixesAccepted + stats.fixesRejected)
        : (stats.fixesApplied > 0 ? 100 : 0),
      rawText: `${stats.fixesAccepted} accepted / ${stats.fixesAccepted + stats.fixesRejected} decisions`,
    },
    {
      subject: "Resolution Rate",
      value: isCleanReviews ? 100 : safePercent(stats.fixesApplied, stats.findingsSurfaced),
      rawText: isCleanReviews
        ? "100% (Clean code)"
        : `${stats.fixesApplied} applied / ${stats.findingsSurfaced} surfaced issues`,
    }
  ];

  const primaryColor = "#6366f1"; // Indigo-500

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload;
      return (
        <div className="bg-popover/95 backdrop-blur-xs border border-border p-3 rounded-lg shadow-lg">
          <p className="font-semibold text-sm mb-1">{item.subject}</p>
          <p className="text-xs text-muted-foreground">{item.rawText}</p>
          <p className="text-xs font-bold mt-1 text-primary">{item.value}% Score</p>
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="h-full flex flex-col justify-between">
      <CardHeader className="pb-2">
        <CardTitle>Review Health</CardTitle>
        <CardDescription>Normalized performance metrics (0-100%)</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-center min-h-[280px]">
        <div className="h-[250px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart cx="50%" cy="50%" outerRadius="68%" data={data}>
              <PolarGrid stroke="currentColor" className="opacity-15" />
              <PolarAngleAxis 
                dataKey="subject" 
                tick={{ fill: 'currentColor', fontSize: 11, fontWeight: 600 }} 
                className="opacity-80"
              />
              <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
              <Radar
                name="Metrics"
                dataKey="value"
                stroke={primaryColor}
                strokeWidth={2.5}
                fill={primaryColor}
                fillOpacity={0.35}
                dot={{ r: 3, fill: primaryColor, stroke: "var(--background)", strokeWidth: 1.5 }}
              />
              <Tooltip content={<CustomTooltip />} />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-2 border-t text-center text-xs">
          <div>
            <div className="text-muted-foreground text-[10px]">Coverage</div>
            <div className="font-semibold">{data[0].value}%</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[10px]">Noise Filter</div>
            <div className="font-semibold">{data[1].value}%</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[10px]">Resolution</div>
            <div className="font-semibold">{data[4].value}%</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
