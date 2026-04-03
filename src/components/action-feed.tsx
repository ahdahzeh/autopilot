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
      {review.length > 0 && (
        <ActionSection
          title="New Today"
          subtitle="Recently found, needs review"
          items={review}
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
      {topPicks.length > 0 && (
        <ActionSection
          title="Top Picks"
          subtitle="High priority, ready to apply"
          items={topPicks}
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

export function ActionSection({
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
  const visible = showAll ? items : items.slice(0, 4);

  return (
    <div>
      <div className="mb-2">
        <h3 className="text-[10px] uppercase tracking-widest text-muted font-medium">{title}</h3>
        <p className="text-[9px] text-muted">{subtitle}</p>
      </div>
      <div className="space-y-2">
        {visible.map((item, i) => (
          <ActionCard key={item.id} item={item} index={i} onDismiss={onDismiss} />
        ))}
      </div>
      {items.length > 4 && (
        <button
          className="text-[10px] text-muted hover:text-foreground mt-2 transition-colors"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : `+ ${items.length - 4} more`}
        </button>
      )}
    </div>
  );
}

function ActionCard({
  item,
  index,
  onDismiss,
}: {
  item: ActionItem;
  index: number;
  onDismiss: (jobId: string, reason: DismissReason) => void;
}) {
  const now = new Date();
  const daysAgo = item.dateApplied
    ? differenceInDays(now, parseISO(item.dateApplied))
    : item.dateFound
      ? differenceInDays(now, parseISO(item.dateFound))
      : null;

  const matchColor =
    item.matchScore !== null
      ? item.matchScore >= 9
        ? "#1D9E75"
        : item.matchScore >= 7
          ? "#BA7517"
          : "#D85A30"
      : undefined;

  return (
    <div className={`border border-border rounded-xl bg-card px-4 py-3 card-hover animate-fade-up stagger-${Math.min(index + 1, 5)}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold truncate">{item.company || item.name}</p>
            {item.matchScore !== null && (
              <span className="mono text-xs font-bold shrink-0" style={{ color: matchColor }}>
                {item.matchScore * 10}%
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted truncate mt-0.5">{item.role}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {item.actionType === "apply" && item.applyLink && (
            <a
              href={item.applyLink}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-accent-purple text-white px-2.5 py-0.5 rounded text-[10px] font-semibold hover:brightness-90 transition"
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
      <div className="flex items-center gap-3 mt-2 text-[9px] mono text-muted">
        {item.location && <span className="truncate max-w-[100px] sm:max-w-[160px]">{item.location}</span>}
        {item.source && <span>{item.source}</span>}
        {item.salaryRange && <span>{item.salaryRange}</span>}
        {daysAgo !== null && <span>{daysAgo}d ago</span>}
      </div>
    </div>
  );
}
