"use client";

import { useEffect, useState, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ActionFeed } from "./action-feed";
import { ContextPanel } from "./context-panel";
import { JobTable } from "./job-table";
import { KanbanBoard } from "./kanban-board";
import { ToastContainer, showToast } from "./toast";
import { AddJobModal } from "./add-job-modal";
import { ThemeToggle } from "./theme-toggle";
import { SupportButton } from "./support-modal";
import { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/types";
import type {
  Stats, WeeklyData, SourceEffectiveness, StatusCount, ActionItem,
} from "@/lib/analytics";
import type { HealthScore } from "@/lib/analytics";
import type { DismissReason } from "@/lib/types";

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
  const [welcoming, setWelcoming] = useState(false);

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

  // Welcome / scrape-in-progress polling: if ?welcome=1 is set (from
  // onboarding or "Run Scrape Now"), poll /api/jobs every 5s until we see
  // new jobs arrive (or hit the max wait). Tracks the starting jobs count
  // so existing users who manually trigger a scrape also get auto-updated
  // when new jobs land, not just first-time users.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("welcome") !== "1") return;

    setWelcoming(true);
    let elapsed = 0;
    let startingCount: number | null = null;
    const MAX_MS = 5 * 60 * 1000;
    const INTERVAL_MS = 5000;

    const finish = () => {
      setWelcoming(false);
      window.history.replaceState({}, "", "/");
    };

    const timer = setInterval(async () => {
      elapsed += INTERVAL_MS;
      try {
        const res = await fetch("/api/jobs");
        if (res.ok) {
          const json = await res.json();
          const count: number = json?.jobs?.length ?? 0;
          const baseline = startingCount ?? count;
          if (startingCount === null) startingCount = count;
          setData(json);
          if (count > baseline) {
            finish();
            clearInterval(timer);
            return;
          }
        }
      } catch {
        // keep polling; transient errors are fine during a scrape
      }
      if (elapsed >= MAX_MS) {
        finish();
        clearInterval(timer);
      }
    }, INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

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

  if (welcoming && (!data || data.jobs.length === 0)) {
    return (
      <div className="flex items-center justify-center min-h-screen px-6">
        <div className="text-center max-w-md space-y-4">
          <div className="text-4xl">🔎</div>
          <h2 className="text-lg font-bold">Finding your first matches…</h2>
          <p className="text-sm text-muted">
            We&apos;re scraping jobs that match your profile. This usually takes 30 to 90 seconds.
            You don&apos;t need to refresh. Results will appear automatically.
          </p>
          <p className="text-[10px] text-muted mono uppercase tracking-widest animate-pulse">
            Searching…
          </p>
          <p className="text-[10px] text-muted pt-4 border-t border-border">
            After today, new jobs arrive daily at <span className="mono">13:00 UTC</span> (9 AM ET / 6 AM PT).
          </p>
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
          <button onClick={fetchData} className="cb-btn mt-4">
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
    <div className="px-4 md:px-8 lg:px-12 py-4 md:py-6">
      {welcoming && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-accent-purple/5 border border-accent-purple/20 flex items-center gap-3">
          <span className="text-lg animate-pulse">🔎</span>
          <p className="text-xs">
            <span className="font-semibold">Scraping new jobs…</span>
            <span className="text-muted ml-2">Results will appear automatically in 1–2 minutes.</span>
          </p>
        </div>
      )}
      {/* Header: brand · view-tabs (center) · actions */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-3 mb-6">
        {/* Brand (left) */}
        <div className="cb-brand justify-self-start">
          <div className="hdr-mark">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="3" x2="12" y2="8" />
              <line x1="12" y1="16" x2="12" y2="21" />
            </svg>
          </div>
          <div>
            <div className="cb-brand__name">Autopilot</div>
            <div className="cb-brand__sub">Updated {new Date(data.updatedAt).toLocaleTimeString()}</div>
          </div>
        </div>

        {/* View switcher (center) */}
        <div className="cb-seg justify-self-center" role="tablist" aria-label="Dashboard view">
          <button
            type="button"
            role="tab"
            aria-selected={view === "action"}
            data-active={view === "action"}
            onClick={() => switchView("action")}
            className="cb-seg__btn"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
            </svg>
            Action
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "pipeline"}
            data-active={view === "pipeline"}
            onClick={() => switchView("pipeline")}
            className="cb-seg__btn"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
            Pipeline
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "kanban"}
            data-active={view === "kanban"}
            onClick={() => switchView("kanban")}
            className="cb-seg__btn"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="6" height="18" />
              <rect x="11" y="3" width="6" height="12" />
              <rect x="19" y="3" width="2" height="8" />
            </svg>
            Kanban
          </button>
        </div>

        {/* Actions (right) */}
        <div className="flex items-center gap-2 flex-wrap justify-self-end">
          <button type="button" onClick={() => setShowAddJob(true)} className="cb-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add job
          </button>
          <button type="button" onClick={fetchData} className="cb-btn" aria-label="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh
          </button>
          <a href="/settings" className="cb-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </a>
          <ThemeToggle />
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
              <div className="flex flex-col md:flex-row gap-4 md:gap-6 items-start">
                {/* Left: Action Feed (60%) */}
                <div className="flex-[6] min-w-0 w-full md:w-auto">
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
      <footer className="ftr mt-10">
        <div>© 2026 · Autopilot · v3.0 · Free & open source</div>
        <div className="ftr-links" style={{ alignItems: "center" }}>
          <SupportButton />
          <a href="https://cerebral.ahdahzeh.com">Cerebral</a>
          <a href="https://ahdahzeh.com">Portfolio</a>
          <a href="/settings">Settings</a>
        </div>
      </footer>

      <AddJobModal open={showAddJob} onClose={() => setShowAddJob(false)} onAdded={fetchData} />
      <ToastContainer />
    </div>
  );
}
