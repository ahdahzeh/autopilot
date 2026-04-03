import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: users, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("onboarded", true);

  if (error || !users) {
    return Response.json({ error: "Failed to fetch users" }, { status: 500 });
  }

  const results = [];

  for (const user of users) {
    const today = new Date().toISOString().split("T")[0];
    const { count } = await supabase
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("date_found", today);

    const remaining = user.daily_job_limit - (count || 0);
    if (remaining <= 0) {
      results.push({ user_id: user.id, skipped: true, reason: "daily limit reached" });
      continue;
    }

    if (process.env.RAILWAY_SCRAPER_URL) {
      try {
        const res = await fetch(`${process.env.RAILWAY_SCRAPER_URL}/scrape`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: user.id,
            target_titles: user.target_titles,
            target_locations: user.target_locations,
            salary_floor: user.salary_floor,
            excluded_companies: user.excluded_companies,
            sources: user.sources,
            daily_job_limit: remaining,
          }),
        });
        const data = await res.json();
        results.push({ user_id: user.id, ...data });
      } catch (err) {
        results.push({ user_id: user.id, error: String(err) });
      }
    } else {
      results.push({ user_id: user.id, skipped: true, reason: "no scraper URL configured" });
    }
  }

  return Response.json({
    processed: users.length,
    results,
    timestamp: new Date().toISOString(),
  });
}
