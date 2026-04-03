"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ActionFeed } from "./action-feed";
import { ContextPanel } from "./context-panel";
import { JobTable } from "./job-table";
import { KanbanBoard } from "./kanban-board";
import { ToastContainer, showToast } from "./toast";
import { AddJobModal } from "./add-job-modal";
import { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/types";
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
  const [view, setView] = useState<"action" | "pipeline" | "kanban">("action");
  const [direction, setDirection] = useState(0);
  const [showAddJob, setShowAddJob] = useState(false);

  const viewOrder = ["action", "pipeline", "kanban"] as const;
  const switchView = (next: typeof view) => {
    const from = viewOrder.indexOf(view);
    const to = viewOrder.indexOf(next);
    setDirection(to > from ? 1 : -1);
    setView(next);
  };

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

  // Jobs already shown in action sections
  const shownIds = new Set([
    ...actions.topPicks.map((j) => j.id),
    ...actions.followUps.map((j) => j.id),
    ...actions.review.map((j) => j.id),
  ]);
  const remainingJobs = visibleJobs.filter((j) => !shownIds.has(j.id));

  return (
    <div className="px-12 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Auto<span className="text-accent-purple">pilot</span></h1>
          <p className="text-[10px] text-muted mono">
            Updated {new Date(data.updatedAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex border border-border rounded-lg overflow-hidden">
            {(["action", "pipeline", "kanban"] as const).map((v) => (
              <button
                key={v}
                onClick={() => switchView(v)}
                className={`px-4 py-2 text-xs font-medium transition-all ${
                  view === v
                    ? "bg-foreground text-white"
                    : "bg-card text-muted hover:bg-background"
                }`}
              >
                {v === "action" ? "Action" : v === "pipeline" ? "Pipeline" : "Kanban"}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowAddJob(true)}
            className="px-4 py-2 text-xs border border-border rounded-lg hover:bg-card transition-colors"
          >
            + Add Job
          </button>
          <button
            onClick={fetchData}
            className="px-4 py-2 text-xs border border-border rounded-lg hover:bg-card transition-colors"
          >
            Refresh
          </button>
          <a
            href="/settings"
            className="px-4 py-2 text-xs text-muted hover:text-foreground transition-colors"
          >
            Settings
          </a>
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={view}
          initial={{ opacity: 0, scale: 0.97, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 1.03, filter: "blur(4px)" }}
          transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
        >
          {view === "pipeline" && (
            <JobTable jobs={visibleJobs} onDismiss={handleDismiss} defaultExpanded />
          )}

          {view === "kanban" && (
            <KanbanBoard jobs={visibleJobs} onDismiss={handleDismiss} />
          )}

          {view === "action" && (
            <>
              {/* Split View */}
              <div className="flex gap-6 items-start">
                {/* Left: Action Feed (60%) */}
                <div className="flex-[6] min-w-0">
                  <ActionFeed
                    topPicks={filterDismissed(actions.topPicks)}
                    followUps={filterDismissed(actions.followUps)}
                    review={filterDismissed(actions.review)}
                    onDismiss={handleDismiss}
                  />
                </div>

                {/* Right: Context Panel (40%) */}
                <div className="flex-[4] min-w-0 hidden md:block sticky top-4 self-start">
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

              {/* Remaining Jobs */}
              {remainingJobs.length > 0 && (
                <div className="mt-6">
                  <JobTable jobs={remainingJobs} onDismiss={handleDismiss} />
                </div>
              )}

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
            </>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Footer */}
      <div className="text-center py-6">
        <p className="text-[9px] text-muted mono uppercase tracking-widest">
          Autopilot v3.0
        </p>
      </div>

      <AddJobModal open={showAddJob} onClose={() => setShowAddJob(false)} onAdded={fetchData} />
      <ToastContainer />
    </div>
  );
}
