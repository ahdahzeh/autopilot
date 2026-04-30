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

  // Negative-feedback companies: last 90 days of "not a fit" signals. Unioned
  // into excluded_companies on the scraper side so we both hard-filter exact
  // matches AND nudge Haiku to down-weight similar companies.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: feedbackRows } = await supabase
    .from("job_feedback")
    .select("company")
    .eq("user_id", user.id)
    .gte("created_at", ninetyDaysAgo);

  const negativeCompanies = Array.from(
    new Set((feedbackRows ?? []).map((r) => (r.company ?? "").trim()).filter(Boolean)),
  );

  // Hard ceiling on the Railway scrape so the Vercel cron can finish its
  // outer loop within maxDuration=300s. Without this, a slow LinkedIn run on
  // user A blocks the cron at await-time, the function gets killed, and
  // users B+ are never attempted. Railway keeps working on the request after
  // we abort — its DB writes still land — we just stop waiting for the
  // response. Trade-off: any jobs Railway hadn't yet inserted at abort time
  // will appear after the cron returns, which is fine for the daily flow.
  const FETCH_TIMEOUT_MS = 90_000;

  try {
    const res = await fetch(`${scraperUrl}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
        priority_industries: user.priority_industries ?? [],
        priority_keywords: user.priority_keywords ?? [],
        // Seniority-aware title variants generated at resume-save time.
        expanded_titles: user.expanded_titles ?? [],
        // "Not a fit" signals from the last 90 days.
        negative_companies: negativeCompanies,
      }),
    });
    const data = await res.json();
    return { user_id: user.id, ...data };
  } catch (err) {
    // AbortError from the timeout is the common case here; lump everything
    // else under "error" so the cron's results array still has a row per user.
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      user_id: user.id,
      error: isTimeout ? `scrape timed out after ${FETCH_TIMEOUT_MS}ms` : String(err),
    };
  }
}
