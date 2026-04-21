import { createServiceClient } from "./supabase/server";

export type ScrapeResult = {
  user_id: string;
  skipped?: boolean;
  reason?: string;
  error?: string;
  [key: string]: unknown;
};

/**
 * Run a scrape pass for a single user. Used by the daily cron (all users)
 * and the user-triggered scrape endpoint (just the logged-in user).
 * Uses the service client; callers must verify the user_id they pass in.
 */
export async function scrapeForUser(userId: string): Promise<ScrapeResult> {
  const supabase = createServiceClient();

  const { data: user, error } = await supabase
    .from("profiles")
    .select("*, resume_text")
    .eq("id", userId)
    .single();

  if (error || !user) {
    return { user_id: userId, skipped: true, reason: "user not found" };
  }

  if (!user.onboarded) {
    return { user_id: userId, skipped: true, reason: "not onboarded" };
  }

  const today = new Date().toISOString().split("T")[0];
  const { count } = await supabase
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("date_found", today);

  const remaining = user.daily_job_limit - (count || 0);
  if (remaining <= 0) {
    return { user_id: user.id, skipped: true, reason: "daily limit reached" };
  }

  const scraperUrl = process.env.RAILWAY_SCRAPER_URL?.trim().replace(/\/+$/, "");
  if (!scraperUrl) {
    return { user_id: user.id, skipped: true, reason: "no scraper URL configured" };
  }

  // Pull ALL active companies — global seed rows (user_id IS NULL) AND every
  // company added by any user. The service client bypasses RLS so we see the
  // full community pool. Users who don't have ATS sources enabled won't have
  // ATS scrapers run anyway (the Python service checks req.sources first).
  const { data: companyRows } = await supabase
    .from("target_companies")
    .select("ats_type, slug, name")
    .eq("active", true);

  const companies = (companyRows ?? []).map((c) => ({
    ats_type: c.ats_type,
    slug: c.slug,
    name: c.name ?? "",
  }));

  try {
    const res = await fetch(`${scraperUrl}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: user.id,
        target_titles: user.target_titles,
        target_locations: user.target_locations,
        salary_floor: user.salary_floor,
        excluded_companies: user.excluded_companies,
        excluded_titles: user.excluded_titles ?? [],
        min_match_score: user.min_match_score ?? 0,
        sources: user.sources,
        daily_job_limit: remaining,
        resume_text: user.resume_text || "",
        companies,
      }),
    });
    const data = await res.json();
    return { user_id: user.id, ...data };
  } catch (err) {
    return { user_id: user.id, error: String(err) };
  }
}
