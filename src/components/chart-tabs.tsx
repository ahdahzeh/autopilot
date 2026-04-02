"use client";

import { useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import type { WeeklyData, SourceEffectiveness } from "@/lib/analytics";

type Tab = "velocity" | "sources" | "goal";

export function ChartTabs({
  velocity,
  sources,
  appsThisWeek,
  weeklyTarget,
}: {
  velocity: WeeklyData[];
  sources: SourceEffectiveness[];
  appsThisWeek: number;
  weeklyTarget: number;
}) {
  const [tab, setTab] = useState<Tab>("velocity");
  const tabs: { value: Tab; label: string }[] = [
    { value: "velocity", label: "Velocity" },
    { value: "sources", label: "Sources" },
    { value: "goal", label: "Weekly Goal" },
  ];

  return (
    <div>
      <div className="flex border border-border rounded overflow-hidden mb-2">
        {tabs.map((t) => (
          <button
            key={t.value}
            className={`flex-1 text-center text-[8px] py-1.5 font-medium transition-colors ${
              tab === t.value ? "bg-foreground text-background" : "text-muted hover:bg-neutral-100"
            }`}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="bg-white border border-border rounded-md p-2 h-[100px]">
        {tab === "velocity" && <VelocityMini data={velocity} />}
        {tab === "sources" && <SourcesMini data={sources} />}
        {tab === "goal" && <WeeklyGoal current={appsThisWeek} target={weeklyTarget} />}
      </div>
    </div>
  );
}

function VelocityMini({ data }: { data: WeeklyData[] }) {
  if (data.length === 0) return <p className="text-[9px] text-muted text-center pt-8">No data yet</p>;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ left: -20, right: 4, top: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
        <XAxis dataKey="week" tick={{ fontSize: 7, fill: "#999" }} />
        <YAxis tick={{ fontSize: 8, fill: "#999" }} allowDecimals={false} />
        <Area type="monotone" dataKey="count" stroke="#00FF66" fill="#00FF6620" strokeWidth={1.5} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function SourcesMini({ data }: { data: SourceEffectiveness[] }) {
  const colors = ["#3b82f6", "#00FF66", "#a855f7", "#f97316", "#FF3B3B", "#737373"];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ left: 40, right: 4, top: 4, bottom: 0 }}>
        <XAxis type="number" tick={{ fontSize: 8, fill: "#999" }} />
        <YAxis type="category" dataKey="source" tick={{ fontSize: 8, fill: "#999" }} width={36} />
        <Bar dataKey="total" radius={[0, 3, 3, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={colors[i % colors.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function WeeklyGoal({ current, target }: { current: number; target: number }) {
  const pct = Math.min(100, (current / target) * 100);
  const color = pct >= 100 ? "#00FF66" : pct >= 50 ? "#facc15" : "#FF3B3B";
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <p className="text-[9px] text-muted">
        Applied <span className="mono font-bold text-foreground">{current}</span> / Goal{" "}
        <span className="mono font-bold text-foreground">{target}</span>
      </p>
      <div className="w-full bg-neutral-200 h-2 rounded-full">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <p className="mono text-xs font-bold" style={{ color }}>{Math.round(pct)}%</p>
    </div>
  );
}
