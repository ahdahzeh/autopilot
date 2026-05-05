import { createServiceClient } from "@/lib/supabase/server";
import { scrapeForUser } from "@/lib/scrape";
import { processOnboardingReminders, processEngagementEmails, processDailyDigest } from "@/lib/email-campaigns";

// Allow up to 5 minutes per invocation — the sequential for-loop was killing
// the cron mid-pass before most users got scraped. We now parallelize, but
// the timeout bump is still load-bearing: a slow scraper + 20+ users
// can still push past 60s.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Render free tier spins down after 15 min of inactivity. Poll /health until
// the container is warm before firing scrapes — avoids the first user's
// request timing out waiting for a cold start. Gives up after 60s so a
// permanently broken scraper doesn't eat the whole cron budget.
async function warmupScraper(scraperUrl: string): Promise<void> {
  const POLL_MS = 5_000;
  const MAX_MS = 60_000;
  const start = Date.now();
  while (Date.now() - start < MAX_MS) {
    try {
      const res = await fetch(`${scraperUrl}/health`, {
        signal: AbortSignal.timeout(4_000),
      });
      if (res.ok) return;
    } catch {
      // container still waking — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.warn("[cron] scraper warmup timed out after 60s — proceeding anyway");
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Wake the scraper before firing per-user requests so the first user
  // doesn't eat the cold-start latency in their own 90s budget.
  if (process.env.RAILWAY_SCRAPER_URL) {
    await warmupScraper(process.env.RAILWAY_SCRAPER_URL.trim().replace(/\/+$/, ""));
  }

  const supabase = createServiceClient();

  const { data: users, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("onboarded", true);

  if (error || !users) {
    return Response.json({ error: "Failed to fetch users" }, { status: 500 });
  }

  // Shuffle so the same first-N users don't always win the cron lottery. If
  // the cron times out partway (Vercel's 300s ceiling vs Railway's slow tail),
  // it was always the SAME tail of users that got skipped — they never got
  // scraped. Fisher-Yates: each user has equal chance of going first today.
  // scrapeForUser() now caps each call at 90s so this should rarely matter,
  // but the shuffle is cheap insurance against future regressions.
  for (let i = users.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [users[i], users[j]] = [users[j], users[i]];
  }

  // Fire all per-user scrapes at Railway in parallel. Railway has its own
  // global Semaphore(1) on /scrape so they queue server-side and process one
  // at a time — preventing OOM. From Vercel's perspective each fetch is
  // independent: those that complete within scrapeForUser's 90s timeout
  // return data, the rest abort but Railway keeps processing in the
  // background and writes to Supabase. Even if Vercel kills the function at
  // maxDuration=300s, Railway has already received every request body and
  // will work through the queue on its own clock.
  const settled = await Promise.allSettled(users.map((u) => scrapeForUser(u.id)));
  const results: Awaited<ReturnType<typeof scrapeForUser>>[] = settled.map((s, j) =>
    s.status === "fulfilled" ? s.value : { user_id: users[j].id, error: String(s.reason) },
  );

  // Gmail sync — internal fetch back to our own sync endpoint.
  try {
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
  } catch (err) {
    console.error("Gmail sync failed:", err);
  }

  // Email campaigns — onboarding reminders for stuck users, then engagement
  // nudges for active users. Each pass writes its own throttle state on the
  // profile so we never double-send.
  const onboarding = await processOnboardingReminders().catch((err) => ({ error: String(err) }));
  const engagement = await processEngagementEmails().catch((err) => ({ error: String(err) }));
  const digest = await processDailyDigest().catch((err) => ({ error: String(err) }));

  return Response.json({
    processed: users.length,
    results,
    onboarding,
    engagement,
    digest,
    timestamp: new Date().toISOString(),
  });
}
