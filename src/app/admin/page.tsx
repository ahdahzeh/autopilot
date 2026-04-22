import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import AdminClient from "./admin-client";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Auth gate: must be logged-in admin
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (!profile?.is_admin) redirect("/");

  // ── Fetch all admin data server-side ─────────────────────────────────────
  const svc = createServiceClient();

  // Users with profile + job counts
  const { data: users } = await svc.from("profiles").select(`
    id,
    display_name,
    onboarded,
    gmail_connected,
    target_titles,
    target_locations,
    salary_floor,
    sources,
    daily_job_limit,
    created_at
  `).order("created_at", { ascending: false });

  // Auth emails — join via auth.users
  const { data: authUsers } = await svc.auth.admin.listUsers();
  const emailMap: Record<string, string> = {};
  for (const u of authUsers?.users ?? []) {
    emailMap[u.id] = u.email ?? "";
    if (u.last_sign_in_at) {
      // store last_sign_in on the map keyed by id
      (emailMap as Record<string, string>)[`${u.id}__last`] = u.last_sign_in_at;
    }
  }

  // Job counts and status breakdown per user
  const { data: jobRows } = await svc
    .from("jobs")
    .select("user_id, status, date_found")
    .is("dismissed_at", null);

  const jobsByUser: Record<
    string,
    { total: number; byStatus: Record<string, number>; lastDate: string | null }
  > = {};
  for (const job of jobRows ?? []) {
    if (!jobsByUser[job.user_id]) {
      jobsByUser[job.user_id] = { total: 0, byStatus: {}, lastDate: null };
    }
    const u = jobsByUser[job.user_id];
    u.total++;
    u.byStatus[job.status] = (u.byStatus[job.status] ?? 0) + 1;
    if (!u.lastDate || job.date_found > u.lastDate) u.lastDate = job.date_found;
  }

  // Aggregate pipeline across all users
  const pipelineAgg: Record<string, number> = {};
  for (const job of jobRows ?? []) {
    pipelineAgg[job.status] = (pipelineAgg[job.status] ?? 0) + 1;
  }

  // Today's new jobs
  const today = new Date().toISOString().split("T")[0];
  const todayCount = (jobRows ?? []).filter((j) => j.date_found === today).length;

  // Scraper health (fire-and-forget read)
  let scraperStatus: "ok" | "down" | "unknown" = "unknown";
  try {
    const r = await fetch(
      `${process.env.RAILWAY_SCRAPER_URL?.trim().replace(/\/+$/, "")}/health`,
      { signal: AbortSignal.timeout(4000) },
    );
    scraperStatus = r.ok ? "ok" : "down";
  } catch {
    scraperStatus = "down";
  }

  // Recent tailor_usage (last 7 days) — aggregate across users
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const { data: tailorUsage } = await svc
    .from("tailor_usage")
    .select("user_id, day, count")
    .gte("day", sevenDaysAgo);

  const tailorTotal7d = (tailorUsage ?? []).reduce((s, r) => s + (r.count ?? 0), 0);

  // Build enriched user list for client
  const enrichedUsers = (users ?? []).map((p) => ({
    ...p,
    email: emailMap[p.id] ?? "",
    last_sign_in: (emailMap as Record<string, string>)[`${p.id}__last`] ?? null,
    jobs: jobsByUser[p.id] ?? { total: 0, byStatus: {}, lastDate: null },
  }));

  return (
    <AdminClient
      users={enrichedUsers}
      pipeline={pipelineAgg}
      todayJobs={todayCount}
      scraperStatus={scraperStatus}
      tailorTotal7d={tailorTotal7d}
      totalUsers={users?.length ?? 0}
      onboardedCount={(users ?? []).filter((u) => u.onboarded).length}
      gmailCount={(users ?? []).filter((u) => u.gmail_connected).length}
    />
  );
}
