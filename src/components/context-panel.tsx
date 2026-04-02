"use client";

import type { Stats, WeeklyData, SourceEffectiveness, StatusCount } from "@/lib/analytics";
import type { HealthScore as HealthScoreType } from "@/lib/analytics";
import { HealthScore } from "./health-score";
import { MiniFunnel } from "./mini-funnel";
import { ChartTabs } from "./chart-tabs";

export function ContextPanel({
  stats,
  healthScore,
  velocity,
  sources,
  statuses,
  appsThisWeek,
}: {
  stats: Stats;
  healthScore: HealthScoreType;
  velocity: WeeklyData[];
  sources: SourceEffectiveness[];
  statuses: StatusCount[];
  appsThisWeek: number;
}) {
  const funnelData = [
    { label: "Found", count: stats.total, max: stats.total, color: "#a3a3a3" },
    { label: "Applied", count: stats.applied, max: stats.total, color: "#00FF66" },
    { label: "Interview", count: stats.interviews, max: stats.total, color: "#3b82f6" },
    { label: "Offer", count: stats.offers, max: stats.total, color: "#a855f7" },
  ];

  return (
    <div className="bg-card rounded-lg border border-border p-4 sticky top-4">
      <HealthScore data={healthScore} />

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-1.5 mb-4">
        <StatBox label="Total" value={stats.total} />
        <StatBox label="Applied" value={stats.applied} color="#00FF66" />
        <StatBox label="Response" value={`${stats.responseRate.toFixed(1)}%`} />
        <StatBox label="Interviews" value={stats.interviews} color="#00FF66" />
      </div>

      <MiniFunnel data={funnelData} />

      {/* Status Pills */}
      <div className="flex flex-wrap gap-1 mb-4">
        {statuses.map((s) => (
          <span
            key={s.status}
            className="px-2 py-0.5 rounded-full text-[8px] font-medium"
            style={{
              backgroundColor: s.color + "20",
              color: s.color === "#a3a3a3" ? "#525252" : s.color,
            }}
          >
            {s.status} {s.count}
          </span>
        ))}
      </div>

      <ChartTabs velocity={velocity} sources={sources} appsThisWeek={appsThisWeek} weeklyTarget={10} />
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-white border border-border rounded px-2.5 py-1.5">
      <p className="text-[7px] uppercase tracking-[1px] text-muted">{label}</p>
      <p className="mono text-lg font-bold" style={color ? { color } : undefined}>
        {value}
      </p>
    </div>
  );
}
