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
