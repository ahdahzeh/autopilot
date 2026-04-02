"use client";

import { useEffect, useState, useCallback } from "react";
import { ActionFeed } from "./action-feed";
import { ContextPanel } from "./context-panel";
import { JobTable } from "./job-table";
import { ToastContainer, showToast } from "./toast";
import type { Job } from "@/lib/notion";
import type {
  Stats, WeeklyData, SourceEffectiveness, StatusCount, ActionItem,
} from "@/lib/analytics";
import type { HealthScore } from "@/lib/analytics";

type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";

type DashboardData = {
  jobs: Job[];
  stats: Stats;
  velocity: WeeklyData[];
  sources: SourceEffectiveness[];
  statuses: StatusCount[];
  healthScore: HealthScore;
  actions: { topPicks: ActionItem[]; followUps: ActionItem[]; review: ActionItem[] };
  appsThisWeek: number;
  updatedAt: string;
};

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/jobs");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      setData(json);
      setDismissedIds(new Set());
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

  const handleDismiss = useCallback((jobId: string, reason: DismissReason) => {
    if (!data) return;
    const job = data.jobs.find((j) => j.id === jobId);
    const company = job?.company || job?.name || "Job";

    setDismissedIds((prev) => new Set(prev).add(jobId));

    const timer = setTimeout(async () => {
      try {
        await fetch(`/api/jobs/${jobId}/dismiss`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
      } catch (err) {
        console.error("Failed to dismiss:", err);
        setDismissedIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    }, 5000);

    showToast({
      id: jobId,
      message: `Dismissed ${company}`,
      onUndo: () => {
        clearTimeout(timer);
        setDismissedIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      },
    });
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="mono text-sm text-muted animate-pulse">Loading pipeline...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center max-w-md">
          <p className="text-accent-red font-medium mb-2">Connection Error</p>
          <p className="text-sm text-muted">{error}</p>
          <button onClick={fetchData} className="mt-4 px-4 py-2 text-xs border border-border rounded hover:bg-card transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const filterDismissed = <T extends { id: string }>(items: T[]) =>
    items.filter((i) => !dismissedIds.has(i.id));

  const { stats, velocity, sources, statuses, healthScore, actions, appsThisWeek: weekApps } = data;
  const visibleJobs = filterDismissed(data.jobs);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Autopilot</h1>
          <p className="text-[10px] text-muted mono">
            Updated {new Date(data.updatedAt).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={fetchData}
          className="px-3 py-1.5 text-[10px] border border-border rounded hover:bg-card transition-colors mono"
        >
          Refresh
        </button>
      </div>

      {/* Split View */}
      <div className="flex gap-4 items-start">
        {/* Left: Action Feed (60%) */}
        <div className="flex-[6] min-w-0">
          <ActionFeed
            topPicks={filterDismissed(actions.topPicks)}
            followUps={filterDismissed(actions.followUps)}
            review={filterDismissed(actions.review)}
            onDismiss={handleDismiss}
          />

          {/* Full Pipeline Table */}
          <div className="mt-6">
            <JobTable jobs={visibleJobs} onDismiss={handleDismiss} />
          </div>
        </div>

        {/* Right: Context Panel (40%) */}
        <div className="flex-[4] min-w-0 hidden md:block">
          <ContextPanel
            stats={stats}
            healthScore={healthScore}
            velocity={velocity}
            sources={sources}
            statuses={statuses}
            appsThisWeek={weekApps}
          />
        </div>
      </div>

      {/* Mobile: Context panel below on small screens */}
      <div className="md:hidden mt-6">
        <ContextPanel
          stats={stats}
          healthScore={healthScore}
          velocity={velocity}
          sources={sources}
          statuses={statuses}
          appsThisWeek={weekApps}
        />
      </div>

      {/* Footer */}
      <div className="text-center py-6">
        <p className="text-[9px] text-muted mono uppercase tracking-widest">
          Autopilot v2.0 — Synced from Notion
        </p>
      </div>

      <ToastContainer />
    </div>
  );
}
