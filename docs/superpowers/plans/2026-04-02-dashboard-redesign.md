# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Autopilot dashboard from a vertical analytics layout to a split-view action-focused tool with dismiss/archive functionality that syncs back to Notion.

**Architecture:** Split view (60/40) — left column is an action feed (cards with Apply/Follow Up/Dismiss buttons organized by priority), right column is a sticky context panel (health score, stats grid, mini funnel, status pills, chart tabs). Dismiss updates Notion directly via `pages.update`. Full pipeline table is collapsed by default below the split view.

**Tech Stack:** Next.js 16 (App Router), Tailwind CSS, Recharts, @notionhq/client v5, date-fns

**Spec:** `docs/superpowers/specs/2026-04-02-dashboard-redesign-design.md`

---

### Task 1: Add health score + action feed helpers to analytics.ts

**Files:**
- Modify: `src/lib/analytics.ts`

- [ ] **Step 1: Add health score types and computation**

Add these exports to the end of `src/lib/analytics.ts`:

```typescript
export type HealthScore = {
  score: number;
  label: string;
  color: string;
  diagnosis: string;
};

export function computeHealthScore(jobs: Job[]): HealthScore {
  const now = new Date();
  const total = jobs.length;
  if (total === 0) return { score: 0, label: "No Data", color: "#737373", diagnosis: "Add jobs to your pipeline" };

  const applied = jobs.filter((j) => ["Applied", "Interview", "Offer"].includes(j.status)).length;
  const interviews = jobs.filter((j) =>
    ["Interview", "Phone Screen", "Final Round", "Offer", "Accepted"].includes(j.outcome) || j.status === "Interview"
  ).length;
  const responded = jobs.filter((j) => j.responseDate).length;
  const responseRate = applied > 0 ? responded / applied : 0;

  // Velocity: apps this week vs target of 10
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const appsThisWeek = jobs.filter((j) => {
    if (!j.dateApplied) return false;
    return parseISO(j.dateApplied) >= weekStart;
  }).length;
  const velocityScore = Math.min(100, (appsThisWeek / 10) * 100);

  // Response rate: 20% = perfect
  const responseScore = Math.min(100, responseRate * 500);

  // Freshness: % of jobs not stale (found >3 days, not applied)
  const staleCount = jobs.filter((j) => {
    if (j.status !== "New" && j.status !== "Reviewing") return false;
    if (!j.dateFound) return false;
    return differenceInDays(now, parseISO(j.dateFound)) > 3;
  }).length;
  const freshnessScore = ((total - staleCount) / total) * 100;

  // Conversion: interviews / applied, 20% = perfect
  const conversionScore = applied > 0 ? Math.min(100, (interviews / applied) * 500) : 0;

  const score = Math.round(
    velocityScore * 0.3 + responseScore * 0.25 + freshnessScore * 0.25 + conversionScore * 0.2
  );

  const diagnoses: string[] = [];
  if (velocityScore < 50) diagnoses.push("Apply more");
  if (responseScore < 50) diagnoses.push("Low response rate");
  if (freshnessScore < 50) diagnoses.push("Many stale jobs");
  if (conversionScore < 30) diagnoses.push("Low interview conversion");

  let label: string;
  let color: string;
  if (score >= 80) { label = "On Track"; color = "#00FF66"; }
  else if (score >= 60) { label = "Keep Going"; color = "#00FF66"; }
  else if (score >= 40) { label = "Needs Attention"; color = "#FF3B3B"; }
  else { label = "Critical"; color = "#FF3B3B"; }

  return { score, label, color, diagnosis: diagnoses.join(" · ") || "Looking good" };
}
```

- [ ] **Step 2: Add action feed categorization helper**

Add this export to the end of `src/lib/analytics.ts`:

```typescript
export type ActionItem = Job & { actionType: "apply" | "follow_up" | "review" };

export function categorizeActions(jobs: Job[]): {
  topPicks: ActionItem[];
  followUps: ActionItem[];
  review: ActionItem[];
} {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = format(yesterday, "yyyy-MM-dd");

  const topPicks = jobs
    .filter((j) => j.priority === "High" && (j.status === "New" || j.status === "Reviewing"))
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
    .map((j) => ({ ...j, actionType: "apply" as const }));

  const followUps = jobs
    .filter((j) => {
      if (j.status !== "Applied") return false;
      if (j.outcome && j.outcome !== "No Response") return false;
      if (!j.dateApplied) return false;
      return differenceInDays(now, parseISO(j.dateApplied)) >= 7;
    })
    .sort((a, b) => (a.dateApplied ?? "").localeCompare(b.dateApplied ?? ""))
    .map((j) => ({ ...j, actionType: "follow_up" as const }));

  const reviewJobs = jobs
    .filter((j) => {
      if (j.status !== "New") return false;
      if (!j.dateFound) return true;
      return j.dateFound >= yesterdayStr;
    })
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
    .map((j) => ({ ...j, actionType: "review" as const }));

  return { topPicks, followUps, review: reviewJobs };
}

export function appsThisWeek(jobs: Job[]): number {
  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  return jobs.filter((j) => {
    if (!j.dateApplied) return false;
    return parseISO(j.dateApplied) >= weekStart;
  }).length;
}
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/analytics.ts
git commit -m "feat: add health score computation and action feed categorization"
```

---

### Task 2: Add dismiss function to Notion lib + API route

**Files:**
- Modify: `src/lib/notion.ts`
- Create: `src/app/api/jobs/[id]/dismiss/route.ts`

- [ ] **Step 1: Add dismissJob function to notion.ts**

Add this export to the end of `src/lib/notion.ts`:

```typescript
type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";

const DISMISS_MAP: Record<DismissReason, { status: string; outcome: string; note: string }> = {
  expired: { status: "Rejected", outcome: "No Response", note: "Dismissed: Expired" },
  scam: { status: "Rejected", outcome: "Rejected", note: "Dismissed: Scam" },
  not_interested: { status: "Rejected", outcome: "Declined", note: "Dismissed: Not Interested" },
  applied_elsewhere: { status: "Applied", outcome: "", note: "Applied through different channel" },
};

export async function dismissJob(pageId: string, reason: DismissReason): Promise<void> {
  const mapping = DISMISS_MAP[reason];

  const properties: Record<string, unknown> = {
    Status: { select: { name: mapping.status } },
    Notes: { rich_text: [{ text: { content: mapping.note } }] },
  };

  if (mapping.outcome) {
    properties.Outcome = { select: { name: mapping.outcome } };
  }

  await notion.pages.update({
    page_id: pageId,
    properties,
  });
}
```

- [ ] **Step 2: Create the dismiss API route**

Create `src/app/api/jobs/[id]/dismiss/route.ts`:

```typescript
import { dismissJob } from "@/lib/notion";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const reason = body.reason;

    if (!["expired", "scam", "not_interested", "applied_elsewhere"].includes(reason)) {
      return Response.json({ error: "Invalid reason" }, { status: 400 });
    }

    await dismissJob(id, reason);
    return Response.json({ ok: true, id, reason });
  } catch (error) {
    console.error("Failed to dismiss job:", error);
    return Response.json({ error: "Failed to update Notion" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds. New route `/api/jobs/[id]/dismiss` appears as dynamic.

- [ ] **Step 4: Commit**

```bash
git add src/lib/notion.ts src/app/api/jobs/[id]/dismiss/route.ts
git commit -m "feat: add dismiss/archive API with Notion two-way sync"
```

---

### Task 3: Build toast component

**Files:**
- Create: `src/components/toast.tsx`

- [ ] **Step 1: Create the undo toast component**

Create `src/components/toast.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";

type ToastItem = {
  id: string;
  message: string;
  onUndo: () => void;
};

let addToastFn: ((toast: ToastItem) => void) | null = null;

export function showToast(toast: ToastItem) {
  addToastFn?.(toast);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<(ToastItem & { expiring: boolean })[]>([]);

  useEffect(() => {
    addToastFn = (toast) => {
      setToasts((prev) => [...prev, { ...toast, expiring: false }]);
      setTimeout(() => {
        setToasts((prev) => prev.map((t) => (t.id === toast.id ? { ...t, expiring: true } : t)));
      }, 4500);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 5000);
    };
    return () => { addToastFn = null; };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center gap-3 bg-foreground text-background px-4 py-2.5 rounded-lg shadow-lg text-sm transition-opacity duration-500 ${toast.expiring ? "opacity-0" : "opacity-100"}`}
        >
          <span>{toast.message}</span>
          <button
            onClick={() => {
              toast.onUndo();
              setToasts((prev) => prev.filter((t) => t.id !== toast.id));
            }}
            className="font-medium text-accent-green hover:underline text-xs"
          >
            Undo
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/toast.tsx
git commit -m "feat: add undo toast component for dismiss actions"
```

---

### Task 4: Build dismiss menu component

**Files:**
- Create: `src/components/dismiss-menu.tsx`

- [ ] **Step 1: Create the dismiss menu popover**

Create `src/components/dismiss-menu.tsx`:

```typescript
"use client";

import { useState, useRef, useEffect } from "react";

type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";

const REASONS: { value: DismissReason; label: string }[] = [
  { value: "not_interested", label: "Not Interested" },
  { value: "expired", label: "Expired" },
  { value: "scam", label: "Scam" },
  { value: "applied_elsewhere", label: "Applied Elsewhere" },
];

export function DismissButton({
  onDismiss,
}: {
  onDismiss: (reason: DismissReason) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        className="bg-neutral-100 text-muted hover:bg-neutral-200 px-2 py-0.5 rounded text-[10px] transition-colors"
        onClick={() => {
          if (!open) onDismiss("not_interested");
        }}
        onMouseDown={() => {
          longPressTimer.current = setTimeout(() => setOpen(true), 500);
        }}
        onMouseUp={() => {
          if (longPressTimer.current) clearTimeout(longPressTimer.current);
        }}
        onMouseLeave={() => {
          if (longPressTimer.current) clearTimeout(longPressTimer.current);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        Dismiss
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-border rounded-lg shadow-lg py-1 z-50 min-w-[160px]">
          {REASONS.map((r) => (
            <button
              key={r.value}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors"
              onClick={() => {
                onDismiss(r.value);
                setOpen(false);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/dismiss-menu.tsx
git commit -m "feat: add dismiss menu with long-press/right-click support"
```

---

### Task 5: Build context panel components (health score, mini funnel, chart tabs)

**Files:**
- Create: `src/components/health-score.tsx`
- Create: `src/components/mini-funnel.tsx`
- Create: `src/components/chart-tabs.tsx`
- Create: `src/components/context-panel.tsx`

- [ ] **Step 1: Create health-score.tsx**

```typescript
"use client";

import type { HealthScore as HealthScoreType } from "@/lib/analytics";

export function HealthScore({ data }: { data: HealthScoreType }) {
  return (
    <div className="text-center pb-4 mb-4 border-b border-border">
      <p className="text-[7px] uppercase tracking-[2px] text-muted mb-1.5">Pipeline Health</p>
      <p className="mono text-5xl font-extrabold leading-none" style={{ color: data.color }}>
        {data.score}
      </p>
      <p className="text-[10px] font-semibold mt-1" style={{ color: data.color }}>
        {data.label}
      </p>
      <p className="text-[9px] text-muted mt-1">{data.diagnosis}</p>
    </div>
  );
}
```

- [ ] **Step 2: Create mini-funnel.tsx**

```typescript
"use client";

type FunnelBar = { label: string; count: number; max: number; color: string };

export function MiniFunnel({ data }: { data: FunnelBar[] }) {
  return (
    <div className="mb-3">
      <p className="text-[7px] uppercase tracking-[1px] text-muted mb-1.5">Funnel</p>
      <div className="space-y-1">
        {data.map((bar) => (
          <div key={bar.label} className="flex items-center gap-1.5 text-[9px]">
            <span className="text-muted w-12 text-right shrink-0">{bar.label}</span>
            <div className="bg-neutral-200 h-2 flex-1 rounded-sm overflow-hidden">
              <div
                className="h-full rounded-sm"
                style={{
                  width: bar.max > 0 ? `${(bar.count / bar.max) * 100}%` : "0%",
                  backgroundColor: bar.color,
                }}
              />
            </div>
            <span className="mono font-semibold w-5 shrink-0">{bar.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create chart-tabs.tsx**

```typescript
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
```

- [ ] **Step 4: Create context-panel.tsx**

```typescript
"use client";

import type { Job } from "@/lib/notion";
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
```

- [ ] **Step 5: Verify build passes**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/health-score.tsx src/components/mini-funnel.tsx src/components/chart-tabs.tsx src/components/context-panel.tsx
git commit -m "feat: add context panel with health score, funnel, stats, and chart tabs"
```

---

### Task 6: Build action feed component

**Files:**
- Create: `src/components/action-feed.tsx`

- [ ] **Step 1: Create action-feed.tsx**

```typescript
"use client";

import { useState } from "react";
import type { ActionItem } from "@/lib/analytics";
import { DismissButton } from "./dismiss-menu";
import { differenceInDays, parseISO } from "date-fns";

type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";

export function ActionFeed({
  topPicks,
  followUps,
  review,
  onDismiss,
}: {
  topPicks: ActionItem[];
  followUps: ActionItem[];
  review: ActionItem[];
  onDismiss: (jobId: string, reason: DismissReason) => void;
}) {
  return (
    <div className="space-y-6">
      {topPicks.length > 0 && (
        <ActionSection
          title="Top Picks"
          subtitle="High priority, ready to apply"
          items={topPicks}
          onDismiss={onDismiss}
        />
      )}
      {followUps.length > 0 && (
        <ActionSection
          title="Follow Ups"
          subtitle="Applied 7+ days, no response"
          items={followUps}
          onDismiss={onDismiss}
        />
      )}
      {review.length > 0 && (
        <ActionSection
          title="New Today"
          subtitle="Recently found, needs review"
          items={review}
          onDismiss={onDismiss}
        />
      )}
      {topPicks.length === 0 && followUps.length === 0 && review.length === 0 && (
        <div className="text-center py-12">
          <p className="text-sm text-muted">No pending actions. You're all caught up.</p>
        </div>
      )}
    </div>
  );
}

function ActionSection({
  title,
  subtitle,
  items,
  onDismiss,
}: {
  title: string;
  subtitle: string;
  items: ActionItem[];
  onDismiss: (jobId: string, reason: DismissReason) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, 5);

  return (
    <div>
      <div className="mb-2">
        <h3 className="text-[10px] uppercase tracking-widest text-muted font-medium">{title}</h3>
        <p className="text-[9px] text-muted">{subtitle}</p>
      </div>
      <div className="space-y-2">
        {visible.map((item) => (
          <ActionCard key={item.id} item={item} onDismiss={onDismiss} />
        ))}
      </div>
      {items.length > 5 && (
        <button
          className="text-[10px] text-muted hover:text-foreground mt-2 transition-colors"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : `+ ${items.length - 5} more`}
        </button>
      )}
    </div>
  );
}

function ActionCard({
  item,
  onDismiss,
}: {
  item: ActionItem;
  onDismiss: (jobId: string, reason: DismissReason) => void;
}) {
  const now = new Date();
  const daysAgo = item.dateApplied
    ? differenceInDays(now, parseISO(item.dateApplied))
    : item.dateFound
      ? differenceInDays(now, parseISO(item.dateFound))
      : null;

  return (
    <div className="border border-border rounded-md px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-neutral-50 transition-colors">
      <div className="min-w-0">
        <p className="text-xs font-semibold truncate">{item.company || item.name}</p>
        <p className="text-[10px] text-muted truncate">
          {item.role}
          {item.matchScore !== null && (
            <span className={`ml-1.5 mono font-bold ${item.matchScore >= 8 ? "text-accent-green" : ""}`}>
              {item.matchScore}/10
            </span>
          )}
          {daysAgo !== null && (
            <span className="ml-1.5 mono">{daysAgo}d ago</span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {item.actionType === "apply" && item.applyLink && (
          <a
            href={item.applyLink}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-accent-green text-black px-2.5 py-0.5 rounded text-[10px] font-semibold hover:brightness-90 transition"
          >
            Apply
          </a>
        )}
        {item.actionType === "follow_up" && (
          <span className="bg-blue-50 text-blue-600 px-2.5 py-0.5 rounded text-[10px] font-semibold">
            Follow Up
          </span>
        )}
        {item.actionType === "review" && item.applyLink && (
          <a
            href={item.applyLink}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-neutral-100 text-foreground px-2.5 py-0.5 rounded text-[10px] font-semibold hover:bg-neutral-200 transition"
          >
            View
          </a>
        )}
        <DismissButton onDismiss={(reason) => onDismiss(item.id, reason)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/action-feed.tsx
git commit -m "feat: add action feed with top picks, follow ups, and review sections"
```

---

### Task 7: Update job table with dismiss support + collapsed default

**Files:**
- Modify: `src/components/job-table.tsx`

- [ ] **Step 1: Rewrite job-table.tsx**

Replace the entire contents of `src/components/job-table.tsx`:

```typescript
"use client";

import { useState } from "react";
import type { Job } from "@/lib/notion";
import { DismissButton } from "./dismiss-menu";

type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";

const STATUS_COLORS: Record<string, string> = {
  New: "bg-neutral-200 text-neutral-700",
  Reviewing: "bg-amber-100 text-amber-800",
  Applied: "bg-green-100 text-green-800",
  Rejected: "bg-red-100 text-red-800",
  Interview: "bg-blue-100 text-blue-800",
  Offer: "bg-purple-100 text-purple-800",
};

export function JobTable({
  jobs,
  onDismiss,
}: {
  jobs: Job[];
  onDismiss: (jobId: string, reason: DismissReason) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"matchScore" | "dateApplied" | "dateFound">("dateFound");

  const statuses = ["all", ...new Set(jobs.map((j) => j.status).filter(Boolean))];

  const filtered = jobs
    .filter((j) => filter === "all" || j.status === filter)
    .sort((a, b) => {
      if (sortBy === "matchScore") return (b.matchScore ?? 0) - (a.matchScore ?? 0);
      const aDate = a[sortBy] ?? "";
      const bDate = b[sortBy] ?? "";
      return bDate.localeCompare(aDate);
    });

  if (!expanded) {
    return (
      <div className="text-center py-4">
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-muted hover:text-foreground border border-border rounded-md px-4 py-2 hover:bg-card transition-colors"
        >
          View Full Pipeline ({jobs.length} jobs)
        </button>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-[10px] uppercase tracking-widest text-muted">
          Pipeline <span className="mono">({filtered.length})</span>
        </h3>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-[10px] border border-border rounded px-2 py-1 bg-white"
          >
            {statuses.map((s) => (
              <option key={s} value={s}>{s === "all" ? "All Statuses" : s}</option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="text-[10px] border border-border rounded px-2 py-1 bg-white"
          >
            <option value="dateFound">Date Found</option>
            <option value="dateApplied">Date Applied</option>
            <option value="matchScore">Match Score</option>
          </select>
          <button
            onClick={() => setExpanded(false)}
            className="text-[10px] text-muted hover:text-foreground"
          >
            Collapse
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border bg-neutral-50">
              <th className="text-left px-3 py-1.5 font-medium text-muted">Company</th>
              <th className="text-left px-3 py-1.5 font-medium text-muted">Role</th>
              <th className="text-left px-3 py-1.5 font-medium text-muted">Score</th>
              <th className="text-left px-3 py-1.5 font-medium text-muted">Status</th>
              <th className="text-left px-3 py-1.5 font-medium text-muted">Source</th>
              <th className="text-left px-3 py-1.5 font-medium text-muted">Applied</th>
              <th className="text-left px-3 py-1.5 font-medium text-muted"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((job) => (
              <tr key={job.id} className="border-b border-border last:border-0 hover:bg-neutral-50 transition-colors">
                <td className="px-3 py-2 font-medium">{job.company || job.name}</td>
                <td className="px-3 py-2 text-muted max-w-[140px] truncate">{job.role}</td>
                <td className="px-3 py-2 mono">
                  {job.matchScore !== null ? (
                    <span className={job.matchScore >= 8 ? "text-accent-green font-bold" : ""}>{job.matchScore}/10</span>
                  ) : <span className="text-muted">--</span>}
                </td>
                <td className="px-3 py-2">
                  {job.status && (
                    <span className={`inline-block px-1.5 py-0.5 rounded-full text-[9px] font-medium ${STATUS_COLORS[job.status] ?? ""}`}>
                      {job.status}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-muted">{job.source}</td>
                <td className="px-3 py-2 mono text-muted">{job.dateApplied ?? "--"}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    {job.applyLink && (
                      <a href={job.applyLink} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline text-[10px]">
                        Link
                      </a>
                    )}
                    <DismissButton onDismiss={(reason) => onDismiss(job.id, reason)} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/job-table.tsx
git commit -m "feat: update job table with dismiss buttons and collapsed default"
```

---

### Task 8: Rewrite dashboard with split view layout + wire everything together

**Files:**
- Modify: `src/components/dashboard.tsx`
- Modify: `src/app/api/jobs/route.ts`

- [ ] **Step 1: Update the API route to include new data**

Replace `src/app/api/jobs/route.ts`:

```typescript
import { fetchJobs } from "@/lib/notion";
import {
  computeStats, computeFunnel, applicationsPerWeek, sourceEffectiveness,
  statusBreakdown, computeHealthScore, categorizeActions, appsThisWeek,
} from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const jobs = await fetchJobs();
    const stats = computeStats(jobs);
    const funnel = computeFunnel(jobs);
    const velocity = applicationsPerWeek(jobs);
    const sources = sourceEffectiveness(jobs);
    const statuses = statusBreakdown(jobs);
    const healthScore = computeHealthScore(jobs);
    const actions = categorizeActions(jobs);
    const weekApps = appsThisWeek(jobs);

    return Response.json({
      jobs,
      stats,
      funnel,
      velocity,
      sources,
      statuses,
      healthScore,
      actions,
      appsThisWeek: weekApps,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to fetch jobs:", error);
    return Response.json({ error: "Failed to fetch from Notion" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Rewrite dashboard.tsx with split view**

Replace `src/components/dashboard.tsx`:

```typescript
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
```

- [ ] **Step 3: Delete alerts-panel.tsx (replaced by action feed)**

```bash
rm src/components/alerts-panel.tsx
```

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: Build succeeds. All routes render.

- [ ] **Step 5: Verify in browser**

Run: `npm run dev`
Open `http://localhost:3003`. Verify:
- Split view layout renders (action feed left, context panel right)
- Health score shows at top of right panel
- Stats, funnel, status pills, and chart tabs all render
- Action cards show Apply/Follow Up/Dismiss buttons
- Clicking Dismiss removes the card and shows an undo toast
- "View Full Pipeline" button expands the table
- Table has dismiss buttons per row

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: redesign dashboard with split view, action feed, and context panel"
```

---

### Task 9: Clean up unused files + final verification

**Files:**
- Delete: `src/components/charts.tsx`

- [ ] **Step 1: Delete charts.tsx (functionality moved to chart-tabs.tsx)**

```bash
rm src/components/charts.tsx
```

- [ ] **Step 2: Verify no imports reference deleted files**

Run: `npm run build`
Expected: Build succeeds with no missing module errors.

- [ ] **Step 3: Full visual verification**

Open `http://localhost:3003` and verify:
1. Header shows "Autopilot" with refresh button
2. Left column: Top Picks, Follow Ups, New Today sections with action cards
3. Right column: Health score (large number, colored), stats 2x2, funnel bars, status pills, chart tabs
4. Chart tabs toggle between Velocity, Sources, Weekly Goal
5. Dismiss: click removes card, toast appears, undo works
6. Dismiss: long-press or right-click shows reason menu
7. "View Full Pipeline" expands table with filters and dismiss per row
8. Mobile (<768px): single column layout, context panel below action feed

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove unused chart and alert components"
```
