import { after } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { scrapeForUser } from "@/lib/scrape";

export const dynamic = "force-dynamic";
// The actual Railway call runs via after() in the background, but give the
// function plenty of headroom since a scrape can take 60-120s.
export const maxDuration = 300;

// User-triggered scrape — scrapes jobs for the currently authenticated user.
//
// Architecture: do all the cheap precheck work synchronously (auth, profile
// load, daily limit, Railway URL) so the user gets a real error response if
// anything is wrong. Only the slow Railway POST runs via after() so the
// client doesn't have to keep the request open.
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Service client because we need a row that may have RLS-protected fields.
  const svc = createServiceClient();
  const { data: profile, error: profileErr } = await svc
    .from("profiles")
    .select("*, resume_text")
    .eq("id", user.id)
    .single();

  if (profileErr || !profile) {
    console.error("[scrape/me] profile load failed", profileErr);
    return Response.json(
      { error: `Could not load your profile: ${profileErr?.message ?? "unknown error"}` },
      { status: 500 },
    );
  }

  if (!profile.onboarded) {
    return Response.json({ error: "Finish onboarding before scraping." }, { status: 400 });
  }

  if (!profile.target_titles?.length || !profile.target_locations?.length) {
    return Response.json(
      { error: "Add target titles and locations in onboarding before scraping." },
      { status: 400 },
    );
  }

  const today = new Date().toISOString().split("T")[0];
  const { count } = await svc
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("date_found", today);

  const remaining = (profile.daily_job_limit ?? 0) - (count || 0);
  if (remaining <= 0) {
    return Response.json(
      {
        error: `Daily limit reached (${count}/${profile.daily_job_limit} jobs today). Try again tomorrow or raise the limit in Settings.`,
      },
      { status: 429 },
    );
  }

  if (!process.env.RAILWAY_SCRAPER_URL) {
    return Response.json(
      { error: "Scraper URL not configured. Contact admin." },
      { status: 500 },
    );
  }

  // All prechecks passed — kick off the Railway call in the background and
  // return immediately so the dashboard can navigate without waiting.
  const userId = user.id;
  after(async () => {
    try {
      const result = await scrapeForUser(userId);
      console.log("[scrape/me] completed", result);
    } catch (err) {
      console.error("[scrape/me] failed", err);
    }
  });

  return Response.json(
    { status: "started", user_id: userId, remaining },
    { status: 202 },
  );
}
