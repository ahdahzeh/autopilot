"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Job, DismissReason } from "@/lib/types";
import { DismissButton } from "./dismiss-menu";
import { JobDetailModal } from "./job-detail-modal";

const COLUMNS = ["New", "Reviewing", "Applied", "Interview", "Offer"] as const;

const COLUMN_COLORS: Record<string, string> = {
  New: "#534AB7",
  Reviewing: "#BA7517",
  Applied: "#1D9E75",
  Interview: "#534AB7",
  Offer: "#1D9E75",
};

const AVATAR_COLORS = [
  "#534AB7", "#1D9E75", "#D85A30", "#BA7517", "#888880",
  "#3C3489", "#085041", "#633806", "#6B4226", "#4A4A4A",
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function KanbanBoard({
  jobs,
  onDismiss,
}: {
  jobs: Job[];
  onDismiss: (jobId: string, reason: DismissReason) => void;
}) {
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  const columns = COLUMNS.map((status) => ({
    status,
    jobs: jobs.filter((j) => j.status === status),
  }));

  return (
    <>
      <div className="flex gap-3 md:gap-4 pb-4 overflow-x-auto" style={{ minHeight: "70vh" }}>
        {columns.map((col) => (
          <div key={col.status} className="flex-1 min-w-[200px] sm:min-w-0">
            <div className="flex items-center gap-2 mb-3 px-1">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: COLUMN_COLORS[col.status] }}
              />
              <h3 className="text-xs font-semibold">{col.status}</h3>
              <span className="mono text-[10px] text-muted">{col.jobs.length}</span>
            </div>
            <div className="space-y-2">
              {col.jobs.map((job) => (
                <KanbanCard
                  key={job.id}
                  job={job}
                  onDismiss={onDismiss}
                  onOpen={() => setDetailJob(job)}
                />
              ))}
              {col.jobs.length === 0 && (
                <div className="border border-dashed border-border rounded-lg p-6 text-center">
                  <p className="text-[10px] text-muted">No jobs</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {detailJob && <JobDetailModal job={detailJob} onClose={() => setDetailJob(null)} />}
    </>
  );
}

function KanbanCard({
  job,
  onDismiss,
  onOpen,
}: {
  job: Job;
  onDismiss: (jobId: string, reason: DismissReason) => void;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const initial = (job.company || job.name || "?")[0].toUpperCase();
  const avatarColor = getAvatarColor(job.company || job.name);
  const matchPct = job.matchScore !== null ? `${job.matchScore * 10}%` : null;
  const matchColor =
    job.matchScore !== null
      ? job.matchScore >= 9
        ? "#1D9E75"
        : job.matchScore >= 7
          ? "#BA7517"
          : "#D85A30"
      : undefined;

  return (
    <div
      className="bg-card border border-border rounded-xl p-3 card-hover group cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{ backgroundColor: avatarColor }}
          >
            {initial}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold truncate">{job.company || job.name}</p>
            <p className="text-[10px] text-muted truncate">{job.role}</p>
          </div>
        </div>
        {matchPct && (
          <span className="mono text-xs font-bold shrink-0" style={{ color: matchColor }}>
            {matchPct}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between mt-2.5">
        <div className="flex items-center gap-2 text-[9px] text-muted mono">
          {job.location && <span className="truncate max-w-[100px]">{job.location}</span>}
          {job.dateApplied && <span>{job.dateApplied.slice(5)}</span>}
          {!job.dateApplied && job.dateFound && <span>{job.dateFound.slice(5)}</span>}
        </div>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <DismissButton onDismiss={(reason) => onDismiss(job.id, reason)} />
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-border mt-2.5 pt-2.5 space-y-1.5">
              {job.source && (
                <div className="flex justify-between text-[9px]">
                  <span className="text-muted">Source</span>
                  <span className="mono">{job.source}</span>
                </div>
              )}
              {job.salaryRange && (
                <div className="flex justify-between text-[9px]">
                  <span className="text-muted">Salary</span>
                  <span className="mono">{job.salaryRange}</span>
                </div>
              )}
              {job.priority && (
                <div className="flex justify-between text-[9px]">
                  <span className="text-muted">Priority</span>
                  <span className="mono">{job.priority}</span>
                </div>
              )}
              {job.outcome && (
                <div className="flex justify-between text-[9px]">
                  <span className="text-muted">Outcome</span>
                  <span className="mono">{job.outcome}</span>
                </div>
              )}
              {job.industry && (
                <div className="flex justify-between text-[9px]">
                  <span className="text-muted">Industry</span>
                  <span className="mono">{job.industry}</span>
                </div>
              )}
              {job.applyLink && (
                <a
                  href={job.applyLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="block text-[9px] text-accent-purple hover:underline mono mt-1"
                >
                  View Listing ↗
                </a>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
                className="block text-[9px] text-accent-purple hover:underline mono mt-1"
              >
                Tailor & Details →
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
