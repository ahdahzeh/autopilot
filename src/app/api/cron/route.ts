import { fetchJobs } from "@/lib/notion";
import { computeStats } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Verify cron secret in production
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobs = await fetchJobs();
  const stats = computeStats(jobs);

  const alerts: string[] = [];

  if (stats.staleJobs.length > 0) {
    alerts.push(`${stats.staleJobs.length} stale job(s) found >3 days ago but not applied to: ${stats.staleJobs.map((j) => j.company).join(", ")}`);
  }

  if (stats.followUps.length > 0) {
    alerts.push(`${stats.followUps.length} application(s) with no response after 7+ days: ${stats.followUps.map((j) => j.company).join(", ")}`);
  }

  if (stats.highPriority > 0) {
    alerts.push(`${stats.highPriority} high-priority job(s) still need attention`);
  }

  // Send push notification if we have subscribers
  // For now, log the alerts — push notification integration comes next
  console.log("Cron alerts:", alerts);

  return Response.json({
    ok: true,
    alertCount: alerts.length,
    alerts,
    stats: {
      total: stats.total,
      applied: stats.applied,
      interviews: stats.interviews,
      responseRate: stats.responseRate,
    },
  });
}
