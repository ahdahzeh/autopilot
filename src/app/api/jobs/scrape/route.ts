import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canDispatchIngest, dispatchIngestForUser } from "@/lib/dispatch-ingest";

export const dynamic = "force-dynamic";

// A repeat press within this window reuses the run already going.
const COOLDOWN_MINUTES = 20;

// User-triggered scrape — scrapes jobs for the currently authenticated user.
//
// Architecture: do the cheap prechecks synchronously (auth, profile load,
// daily limit, cooldown) so the user gets a real error if anything is wrong,
// then hand the scrape to GitHub Actions and return straight away.
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

  // The scrape runs as a one-user GitHub Actions run (src/lib/dispatch-ingest.ts),
  // the same pipeline as the daily ingest. Without a dispatch token the user
  // still gets an honest answer: their jobs come with the next daily run.
  if (!canDispatchIngest()) {
    return Response.json(
      { status: "scheduled", message: "Your first matches arrive with tomorrow morning's run." },
      { status: 202 },
    );
  }

  const last = profile.on_demand_scrape_at ? new Date(profile.on_demand_scrape_at).getTime() : 0;
  if (Date.now() - last < COOLDOWN_MINUTES * 60_000) {
    return Response.json(
      { status: "running", message: "A search for you is already running. New jobs show up within about 15 minutes." },
      { status: 202 },
    );
  }

  const userId = user.id;
  const dispatched = await dispatchIngestForUser(userId);
  if (!dispatched.ok) {
    console.error("[scrape/me] dispatch failed", dispatched.error);
    return Response.json({ error: "Could not start a search right now. Try again in a few minutes." }, { status: 502 });
  }
  await svc.from("profiles").update({ on_demand_scrape_at: new Date().toISOString() }).eq("id", userId);

  return Response.json(
    { status: "started", user_id: userId, remaining },
    { status: 202 },
  );
}
