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
