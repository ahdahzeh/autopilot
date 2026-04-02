import type { Job } from "./notion";
import { differenceInDays, parseISO, startOfWeek, format } from "date-fns";

export type Stats = {
  total: number;
  applied: number;
  interviews: number;
  offers: number;
  rejected: number;
  noResponse: number;
  responseRate: number;
  avgDaysToResponse: number;
  avgMatchScore: number;
  highPriority: number;
  staleJobs: Job[];
  followUps: Job[];
};

export function computeStats(jobs: Job[]): Stats {
  const total = jobs.length;
  const applied = jobs.filter((j) => ["Applied", "Interview", "Offer"].includes(j.status)).length;
  const interviews = jobs.filter((j) => ["Interview", "Phone Screen", "Final Round"].includes(j.outcome) || j.status === "Interview").length;
  const offers = jobs.filter((j) => j.outcome === "Offer" || j.outcome === "Accepted" || j.status === "Offer").length;
  const rejected = jobs.filter((j) => j.status === "Rejected" || j.outcome === "Rejected").length;
  const noResponse = jobs.filter((j) => j.outcome === "No Response" && j.status === "Applied").length;

  const responded = jobs.filter((j) => j.responseDate);
  const responseRate = applied > 0 ? (responded.length / applied) * 100 : 0;

  const daysToResponse = jobs
    .filter((j) => j.dateApplied && j.responseDate)
    .map((j) => differenceInDays(parseISO(j.responseDate!), parseISO(j.dateApplied!)));
  const avgDaysToResponse = daysToResponse.length > 0
    ? daysToResponse.reduce((a, b) => a + b, 0) / daysToResponse.length
    : 0;

  const scores = jobs.filter((j) => j.matchScore !== null).map((j) => j.matchScore!);
  const avgMatchScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  const highPriority = jobs.filter((j) => j.priority === "High" && j.status !== "Applied" && j.status !== "Rejected").length;

  const now = new Date();
  const staleJobs = jobs.filter((j) => {
    if (j.status !== "New" && j.status !== "Reviewing") return false;
    if (!j.dateFound) return false;
    return differenceInDays(now, parseISO(j.dateFound)) > 3;
  });

  const followUps = jobs.filter((j) => {
    if (j.status !== "Applied") return false;
    if (j.outcome && j.outcome !== "No Response") return false;
    if (!j.dateApplied) return false;
    return differenceInDays(now, parseISO(j.dateApplied)) >= 7;
  });

  return { total, applied, interviews, offers, rejected, noResponse, responseRate, avgDaysToResponse, avgMatchScore, highPriority, staleJobs, followUps };
}

export type FunnelStage = { name: string; count: number; rate: string };

export function computeFunnel(jobs: Job[]): FunnelStage[] {
  const total = jobs.length;
  const applied = jobs.filter((j) => j.status !== "New" && j.status !== "Reviewing").length;
  const phoneScreen = jobs.filter((j) => ["Phone Screen", "Interview", "Final Round", "Offer", "Accepted"].includes(j.outcome)).length;
  const interview = jobs.filter((j) => ["Interview", "Final Round", "Offer", "Accepted"].includes(j.outcome)).length;
  const finalRound = jobs.filter((j) => ["Final Round", "Offer", "Accepted"].includes(j.outcome)).length;
  const offer = jobs.filter((j) => ["Offer", "Accepted"].includes(j.outcome)).length;

  const pct = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
  return [
    { name: "Found", count: total, rate: "100%" },
    { name: "Applied", count: applied, rate: pct(applied) },
    { name: "Phone Screen", count: phoneScreen, rate: pct(phoneScreen) },
    { name: "Interview", count: interview, rate: pct(interview) },
    { name: "Final Round", count: finalRound, rate: pct(finalRound) },
    { name: "Offer", count: offer, rate: pct(offer) },
  ];
}

export type WeeklyData = { week: string; count: number };

export function applicationsPerWeek(jobs: Job[]): WeeklyData[] {
  const weeks = new Map<string, number>();
  for (const job of jobs) {
    if (!job.dateApplied) continue;
    const weekStart = startOfWeek(parseISO(job.dateApplied), { weekStartsOn: 1 });
    const key = format(weekStart, "MMM d");
    weeks.set(key, (weeks.get(key) ?? 0) + 1);
  }
  return Array.from(weeks.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, count]) => ({ week, count }));
}

export type SourceEffectiveness = {
  source: string;
  total: number;
  applied: number;
  interviews: number;
  responseRate: number;
};

export function sourceEffectiveness(jobs: Job[]): SourceEffectiveness[] {
  const sources = new Map<string, Job[]>();
  for (const job of jobs) {
    const src = job.source || "Unknown";
    if (!sources.has(src)) sources.set(src, []);
    sources.get(src)!.push(job);
  }

  return Array.from(sources.entries()).map(([source, sourceJobs]) => {
    const applied = sourceJobs.filter((j) => j.status !== "New" && j.status !== "Reviewing").length;
    const interviews = sourceJobs.filter((j) =>
      ["Phone Screen", "Interview", "Final Round", "Offer", "Accepted"].includes(j.outcome) ||
      j.status === "Interview"
    ).length;
    const responded = sourceJobs.filter((j) => j.responseDate).length;
    return {
      source,
      total: sourceJobs.length,
      applied,
      interviews,
      responseRate: applied > 0 ? (responded / applied) * 100 : 0,
    };
  });
}

export type StatusCount = { status: string; count: number; color: string };

export function statusBreakdown(jobs: Job[]): StatusCount[] {
  const colorMap: Record<string, string> = {
    New: "#a3a3a3",
    Reviewing: "#facc15",
    Applied: "#00FF66",
    Rejected: "#FF3B3B",
    Interview: "#3b82f6",
    Offer: "#a855f7",
  };
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const s = job.status || "Unknown";
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([status, count]) => ({
    status,
    count,
    color: colorMap[status] ?? "#737373",
  }));
}

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
