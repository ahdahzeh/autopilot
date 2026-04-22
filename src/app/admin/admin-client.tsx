"use client";

import { useState } from "react";

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  onboarded: boolean;
  gmail_connected: boolean;
  target_titles: string[] | null;
  target_locations: string[] | null;
  salary_floor: number | null;
  sources: string[] | null;
  daily_job_limit: number | null;
  created_at: string;
  last_sign_in: string | null;
  jobs: {
    total: number;
    byStatus: Record<string, number>;
    lastDate: string | null;
  };
};

type Props = {
  users: UserRow[];
  pipeline: Record<string, number>;
  todayJobs: number;
  scraperStatus: "ok" | "down" | "unknown";
  tailorTotal7d: number;
  totalUsers: number;
  onboardedCount: number;
  gmailCount: number;
};

const STATUS_ORDER = ["New", "Reviewing", "Applied", "Interview", "Offer", "Rejected"];
const STATUS_COLOR: Record<string, string> = {
  New: "#888",
  Reviewing: "#888",
  Applied: "var(--accent-purple)",
  Interview: "#f59e0b",
  Offer: "var(--accent-green)",
  Rejected: "var(--accent-red)",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function AdminClient({
  users,
  pipeline,
  todayJobs,
  scraperStatus,
  tailorTotal7d,
  totalUsers,
  onboardedCount,
  gmailCount,
}: Props) {
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncResults, setSyncResults] = useState<Record<string, string>>({});
  const [scraping, setScraping] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const totalJobs = Object.values(pipeline).reduce((s, n) => s + n, 0);

  async function syncUserGmail(userId: string, email: string) {
    setSyncing(userId);
    try {
      const res = await fetch("/api/admin/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync_gmail", userId }),
      });
      const data = await res.json();
      setSyncResults((r) => ({
        ...r,
        [userId]: data.error
          ? `Error: ${data.error}`
          : `${data.updated ?? 0} updated, ${data.emails_scanned ?? 0} emails, ${data.calendar_matched ?? 0} calendar`,
      }));
    } catch {
      setSyncResults((r) => ({ ...r, [userId]: "Failed" }));
    } finally {
      setSyncing(null);
    }
  }

  async function scrapeUser(userId: string) {
    setScraping(userId);
    try {
      const res = await fetch("/api/admin/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scrape", userId }),
      });
      const data = await res.json();
      setSyncResults((r) => ({
        ...r,
        [userId]: data.error
          ? `Scrape error: ${data.error}`
          : `Scraped: ${data.jobs_added ?? 0} added`,
      }));
    } catch {
      setSyncResults((r) => ({ ...r, [userId]: "Scrape failed" }));
    } finally {
      setScraping(null);
    }
  }

  const filteredUsers = users.filter(
    (u) =>
      !search ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      (u.display_name ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div
      className="min-h-screen px-4 md:px-8 lg:px-12 py-6"
      style={{ background: "var(--background)" }}
    >
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-lg font-bold">Admin</h1>
            <p className="text-[10px] mono text-muted uppercase tracking-widest mt-0.5">Control Panel</p>
          </div>
          <a href="/" className="cb-btn text-sm">← Dashboard</a>
        </div>

        {/* Overview cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <StatCard label="Total users" value={totalUsers} />
          <StatCard label="Onboarded" value={onboardedCount} sub={`${Math.round((onboardedCount / Math.max(totalUsers, 1)) * 100)}%`} />
          <StatCard label="Gmail connected" value={gmailCount} sub={`${Math.round((gmailCount / Math.max(totalUsers, 1)) * 100)}%`} />
          <StatCard label="Jobs added today" value={todayJobs} accent="var(--accent-green)" />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <StatCard label="Total jobs (active)" value={totalJobs} />
          <StatCard label="Interviews" value={pipeline["Interview"] ?? 0} accent="#f59e0b" />
          <StatCard label="Offers" value={pipeline["Offer"] ?? 0} accent="var(--accent-green)" />
          <StatCard label="Tailoring runs (7d)" value={tailorTotal7d} />
        </div>

        {/* System health */}
        <div className="mb-8">
          <SectionTitle>System Health</SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <HealthCard
              label="Railway Scraper"
              status={scraperStatus}
              detail={scraperStatus === "ok" ? "Responding" : "Not reachable"}
            />
            <HealthCard label="Vercel API" status="ok" detail="This request succeeded" />
            <HealthCard label="Supabase DB" status="ok" detail="Data loaded successfully" />
          </div>
        </div>

        {/* Pipeline breakdown */}
        <div className="mb-8">
          <SectionTitle>Pipeline (all users)</SectionTitle>
          <div className="flex items-end gap-2 px-4 py-4 border border-border rounded-xl bg-card flex-wrap">
            {STATUS_ORDER.map((s) => {
              const count = pipeline[s] ?? 0;
              const pct = totalJobs ? Math.round((count / totalJobs) * 100) : 0;
              return (
                <div key={s} className="flex flex-col items-center gap-1 flex-1 min-w-[60px]">
                  <span className="mono text-sm font-bold tabular-nums">{count}</span>
                  <div
                    className="w-full rounded-sm"
                    style={{
                      height: `${Math.max(4, pct * 1.5)}px`,
                      background: STATUS_COLOR[s] ?? "#888",
                      opacity: count ? 1 : 0.2,
                    }}
                  />
                  <span className="text-[9px] mono uppercase tracking-widest text-muted">{s}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Users table */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <SectionTitle>User Accounts</SectionTitle>
            <input
              type="text"
              placeholder="Search users..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-3 py-1.5 text-xs border border-border rounded-lg bg-white focus:outline-none mono"
            />
          </div>

          <div className="space-y-3">
            {filteredUsers.map((u) => (
              <div
                key={u.id}
                className="border border-border rounded-xl bg-card overflow-hidden"
              >
                {/* Row header */}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold truncate">{u.email}</span>
                      {u.display_name && (
                        <span className="text-[10px] text-muted">({u.display_name})</span>
                      )}
                      {!u.onboarded && (
                        <Tag color="var(--accent-red)">not onboarded</Tag>
                      )}
                      {u.gmail_connected && <Tag color="var(--accent-green)">gmail ✓</Tag>}
                    </div>
                    <div className="flex gap-3 mt-0.5 flex-wrap">
                      <span className="mono text-[9px] text-muted">
                        joined {new Date(u.created_at).toLocaleDateString()}
                      </span>
                      {u.last_sign_in && (
                        <span className="mono text-[9px] text-muted">
                          last seen {timeAgo(u.last_sign_in)}
                        </span>
                      )}
                      {u.jobs.lastDate && (
                        <span className="mono text-[9px] text-muted">
                          last job {u.jobs.lastDate}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Quick stats */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="text-right">
                      <p className="mono text-sm font-bold">{u.jobs.total}</p>
                      <p className="mono text-[9px] text-muted">jobs</p>
                    </div>
                    <div className="text-right">
                      <p className="mono text-sm font-bold" style={{ color: "#f59e0b" }}>
                        {u.jobs.byStatus["Interview"] ?? 0}
                      </p>
                      <p className="mono text-[9px] text-muted">interviews</p>
                    </div>
                    <div className="text-right">
                      <p className="mono text-sm font-bold" style={{ color: "var(--accent-green)" }}>
                        {u.jobs.byStatus["Offer"] ?? 0}
                      </p>
                      <p className="mono text-[9px] text-muted">offers</p>
                    </div>
                  </div>
                </div>

                {/* User detail: titles, sources, status bars */}
                <div className="px-4 pb-3 border-t border-border/50 pt-2 space-y-2">
                  {/* Titles */}
                  {u.target_titles?.length ? (
                    <p className="text-[10px] text-muted truncate">
                      <span className="font-medium text-foreground/60">Roles: </span>
                      {u.target_titles.slice(0, 4).join(", ")}
                      {(u.target_titles.length > 4) ? ` +${u.target_titles.length - 4}` : ""}
                    </p>
                  ) : null}

                  {/* Sources */}
                  {u.sources?.length ? (
                    <div className="flex gap-1 flex-wrap">
                      {u.sources.map((s) => (
                        <span key={s} className="mono text-[8px] uppercase tracking-widest px-1.5 py-0.5 rounded border border-border text-muted">
                          {s}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {/* Status mini-bars */}
                  {u.jobs.total > 0 && (
                    <div className="flex gap-1 items-center">
                      {STATUS_ORDER.map((s) => {
                        const cnt = u.jobs.byStatus[s] ?? 0;
                        if (!cnt) return null;
                        const w = Math.max(20, (cnt / u.jobs.total) * 120);
                        return (
                          <div
                            key={s}
                            title={`${s}: ${cnt}`}
                            className="flex items-center justify-center rounded text-[7px] font-bold text-white"
                            style={{
                              width: `${w}px`,
                              height: "14px",
                              background: STATUS_COLOR[s] ?? "#888",
                              opacity: 0.9,
                            }}
                          >
                            {cnt}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-1 flex-wrap">
                    {u.gmail_connected && (
                      <button
                        onClick={() => syncUserGmail(u.id, u.email)}
                        disabled={syncing === u.id}
                        className="cb-btn text-[10px] py-1 px-2"
                      >
                        {syncing === u.id ? "Syncing…" : "Sync Gmail"}
                      </button>
                    )}
                    {u.onboarded && (
                      <button
                        onClick={() => scrapeUser(u.id)}
                        disabled={scraping === u.id}
                        className="cb-btn text-[10px] py-1 px-2"
                      >
                        {scraping === u.id ? "Scraping…" : "Run scrape"}
                      </button>
                    )}
                    {syncResults[u.id] && (
                      <span className="mono text-[9px] text-muted">{syncResults[u.id]}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {filteredUsers.length === 0 && (
              <p className="text-[10px] text-muted text-center py-8">No users found.</p>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="px-4 py-3 border border-border rounded-xl bg-card">
      <p className="text-[10px] mono uppercase tracking-widest text-muted mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-bold mono tabular-nums" style={accent ? { color: accent } : {}}>
          {value.toLocaleString()}
        </span>
        {sub && <span className="text-[10px] text-muted mono">{sub}</span>}
      </div>
    </div>
  );
}

function HealthCard({
  label,
  status,
  detail,
}: {
  label: string;
  status: "ok" | "down" | "unknown";
  detail: string;
}) {
  const color =
    status === "ok"
      ? "var(--accent-green)"
      : status === "down"
        ? "var(--accent-red)"
        : "#888";
  const dot = status === "ok" ? "●" : status === "down" ? "●" : "○";

  return (
    <div className="px-4 py-3 border border-border rounded-xl bg-card flex items-center justify-between gap-3">
      <div>
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-[9px] text-muted mono mt-0.5">{detail}</p>
      </div>
      <span className="text-sm" style={{ color }}>
        {dot}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[10px] uppercase tracking-widest text-muted font-medium mb-3">{children}</h2>
  );
}

function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      className="mono text-[8px] uppercase tracking-widest px-1.5 py-0.5 rounded border font-medium"
      style={{ color, borderColor: color, opacity: 0.8 }}
    >
      {children}
    </span>
  );
}
