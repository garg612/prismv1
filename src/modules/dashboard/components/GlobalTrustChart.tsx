"use client";

import React, { useState, useMemo } from "react";
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

interface GlobalTrustChartProps {
  snapshots: {
    id: string;
    metric: string;
    value: number;
    numerator: number;
    denominator: number;
    createdAt: Date | string;
  }[];
  isLoading: boolean;
}

type Timeframe = "days" | "weeks" | "months" | "years";

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-popover/95 backdrop-blur-xs border border-border p-3 rounded-lg shadow-lg min-w-[200px]">
        <p className="font-semibold text-sm mb-2 text-foreground">{payload[0].payload.displayDate}</p>
        {payload.map((entry: any, index: number) => {
          const metricName = entry.dataKey === "FALSE_ALARM_RATE" ? "False Alarm Rate" : "Fix Acceptance";
          const rawData = entry.payload.raw[entry.dataKey];
          const rawText = rawData && rawData.den > 0 ? `(${rawData.num}/${rawData.den})` : "(0/0)";
          
          return (
            <div key={index} className="flex justify-between items-center text-xs mb-1.5 gap-4">
              <div className="flex items-center gap-2">
                <div className="size-2 rounded-full shadow-xs" style={{ backgroundColor: entry.color }} />
                <span className="text-muted-foreground font-medium">{metricName}</span>
              </div>
              <div className="font-bold text-foreground tabular-nums">
                {entry.value !== null && entry.value !== undefined ? `${entry.value.toFixed(1)}%` : 'No data'}
                <span className="text-[10px] text-muted-foreground ml-1 font-normal">{rawText}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  return null;
};

export function GlobalTrustChart({ snapshots, isLoading }: GlobalTrustChartProps) {
  const [timeframe, setTimeframe] = useState<Timeframe>("days");

  const chartData = useMemo(() => {
    if (!snapshots || snapshots.length === 0) return [];
    
    const grouped = new Map<string, any>();
    
    for (const snap of snapshots) {
      const date = new Date(snap.createdAt);
      let timeKey = "";
      let displayDate = "";

      if (timeframe === "days") {
        timeKey = date.toISOString().split("T")[0];
        displayDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
      } else if (timeframe === "weeks") {
        // Simple week grouping by ISO week
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
        timeKey = `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
        displayDate = `Week ${weekNo}, ${d.getUTCFullYear()}`;
      } else if (timeframe === "months") {
        timeKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        displayDate = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(date);
      } else if (timeframe === "years") {
        timeKey = `${date.getFullYear()}`;
        displayDate = `${date.getFullYear()}`;
      }
      
      if (!grouped.has(timeKey)) {
        grouped.set(timeKey, {
          timestamp: timeKey,
          displayDate,
          raw: {
            FALSE_ALARM_RATE: { num: 0, den: 0 },
            FIX_ACCEPTANCE_RATE: { num: 0, den: 0 }
          }
        });
      }
      
      const entry = grouped.get(timeKey)!;
      if (entry.raw[snap.metric]) {
        entry.raw[snap.metric].num += snap.numerator;
        entry.raw[snap.metric].den += snap.denominator;
      }
    }
    
    // Calculate aggregated percentages
    const result = Array.from(grouped.values()).map(entry => {
      const falseAlarmNum = entry.raw.FALSE_ALARM_RATE.num;
      const falseAlarmDen = entry.raw.FALSE_ALARM_RATE.den;
      const fixAcceptNum = entry.raw.FIX_ACCEPTANCE_RATE.num;
      const fixAcceptDen = entry.raw.FIX_ACCEPTANCE_RATE.den;

      return {
        ...entry,
        FALSE_ALARM_RATE: falseAlarmDen > 0 ? Math.round((falseAlarmNum / falseAlarmDen) * 100 * 10) / 10 : null,
        FIX_ACCEPTANCE_RATE: fixAcceptDen > 0 ? Math.round((fixAcceptNum / fixAcceptDen) * 100 * 10) / 10 : null,
      };
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return result;
  }, [snapshots, timeframe]);

  if (isLoading) {
    return (
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle>Global Product Trust</CardTitle>
          <CardDescription>Historical platform-wide metrics</CardDescription>
        </CardHeader>
        <CardContent className="h-[220px] flex items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle>Global Product Trust</CardTitle>
          <CardDescription>Historical trend of platform-wide metrics</CardDescription>
        </div>
        <div className="flex space-x-1 bg-muted/60 p-1 rounded-lg border border-border/50">
          {(["days", "weeks", "months", "years"] as Timeframe[]).map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                timeframe === tf 
                  ? "bg-background text-foreground shadow-xs font-semibold" 
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tf.charAt(0).toUpperCase() + tf.slice(1)}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="pt-2 pb-4">
        {chartData.length === 0 ? (
          <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground border border-dashed rounded-lg">
            No global metrics snapshots recorded yet.
          </div>
        ) : (
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <LineChart data={chartData} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="opacity-10" />
                <XAxis 
                  dataKey="displayDate" 
                  tickLine={false} 
                  axisLine={false} 
                  className="text-[11px] text-muted-foreground font-medium" 
                  minTickGap={25}
                  dy={6} 
                />
                <YAxis 
                  tickLine={false} 
                  axisLine={false} 
                  className="text-[11px] text-muted-foreground font-medium" 
                  width={35} 
                  domain={[0, 100]}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'currentColor', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.2 }} />
                <Legend wrapperStyle={{ fontSize: '12px', fontWeight: '500', paddingTop: '6px' }} iconType="circle" />
                <Line 
                  type="linear"
                  dataKey="FALSE_ALARM_RATE" 
                  name="False Alarm Rate" 
                  stroke="#ef4444" 
                  strokeWidth={2.5} 
                  connectNulls={true}
                  dot={{ r: 3.5, strokeWidth: 1.5, fill: "var(--background)", stroke: "#ef4444" }} 
                  activeDot={{ r: 5, strokeWidth: 0, fill: "#ef4444" }} 
                />
                <Line 
                  type="linear"
                  dataKey="FIX_ACCEPTANCE_RATE" 
                  name="Fix Acceptance" 
                  stroke="#22c55e" 
                  strokeWidth={2.5} 
                  connectNulls={true}
                  dot={{ r: 3.5, strokeWidth: 1.5, fill: "var(--background)", stroke: "#22c55e" }} 
                  activeDot={{ r: 5, strokeWidth: 0, fill: "#22c55e" }} 
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
