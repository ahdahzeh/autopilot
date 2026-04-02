"use client";

import { useEffect, useState, useCallback } from "react";
import { StatCard } from "./stat-card";
import { FunnelChart, VelocityChart, SourceChart, StatusDonut } from "./charts";
import { AlertsPanel } from "./alerts-panel";
import { JobTable } from "./job-table";
import type { Job } from "@/lib/notion";
import type { Stats, FunnelStage, WeeklyData, SourceEffectiveness, StatusCount } from "@/lib/analytics";

type DashboardData = {
  jobs: Job[];
  stats: Stats;
  funnel: FunnelStage[];
  velocity: WeeklyData[];
  sources: SourceEffectiveness[];
  statuses: StatusCount[];
  updatedAt: string;
};

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/jobs");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      setData(json);
      setError(null);
    } catch {
      setError("Could not load data from Notion. Check your API key and database ID.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="mono text-sm text-muted animate-pulse">Loading pipeline...</div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center max-w-md">
          <p className="text-accent-red font-medium mb-2">Connection Error</p>
          <p className="text-sm text-muted">{error}</p>
          <button
            onClick={fetchData}
            className="mt-4 px-4 py-2 text-xs border border-border rounded hover:bg-card transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { jobs, stats, funnel, velocity, sources, statuses } = data;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Autopilot</h1>
          <p className="text-xs text-muted mt-1">
            Job Search Dashboard
            <span className="mono ml-2">
              Updated {new Date(data.updatedAt).toLocaleTimeString()}
            </span>
          </p>
        </div>
        <button
          onClick={fetchData}
          className="px-3 py-1.5 text-xs border border-border rounded hover:bg-card transition-colors mono"
        >
          Refresh
        </button>
      </div>

      {/* Alerts */}
      <div className="mb-8">
        <AlertsPanel stats={stats} />
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-8">
        <StatCard label="Total Jobs" value={stats.total} />
        <StatCard label="Applied" value={stats.applied} accent="green" />
        <StatCard label="Interviews" value={stats.interviews} accent="green" />
        <StatCard label="Offers" value={stats.offers} accent="green" />
        <StatCard
          label="Response Rate"
          value={`${stats.responseRate.toFixed(1)}%`}
          sub={`avg ${stats.avgDaysToResponse.toFixed(0)}d to respond`}
        />
        <StatCard
          label="Avg Score"
          value={stats.avgMatchScore.toFixed(1)}
          sub="out of 10"
        />
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <FunnelChart data={funnel} />
        <VelocityChart data={velocity} />
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        <SourceChart data={sources} />
        <StatusDonut data={statuses} />
      </div>

      {/* Job Table */}
      <JobTable jobs={jobs} onDismiss={() => {}} />

      {/* Footer */}
      <div className="text-center py-8">
        <p className="text-[10px] text-muted mono uppercase tracking-widest">
          Autopilot v1.0 - Synced from Notion
        </p>
      </div>
    </div>
  );
}
