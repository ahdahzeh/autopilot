import { createServiceClient } from "@/lib/supabase/server";
import { scrapeForUser } from "@/lib/scrape";
import { processOnboardingReminders, processEngagementEmails } from "@/lib/email-campaigns";

// Allow up to 5 minutes per invocation — the sequential for-loop was killing
// the cron mid-pass before most users got scraped. We now parallelize, but
// the timeout bump is still load-bearing: a slow Railway scraper + 20+ users
// can still push past 60s.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: users, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("onboarded", true);

  if (error || !users) {
    return Response.json({ error: "Failed to fetch users" }, { status: 500 });
  }

  // Run scrapes in throttled batches. Fully parallel (Promise.all on all 8+
  // users) OOM'd Railway because each Playwright session eats ~400MB and the
  // container is tighter than that. Fully sequential starves Vercel's 300s
  // budget. Batches of 2 are the sweet spot — two scrapes share Railway RAM
  // comfortably and we fit ~10 users in under 3 minutes.
  const CONCURRENCY = 2;
  const results: Awaited<ReturnType<typeof scrapeForUser>>[] = [];
  for (let i = 0; i < users.length; i += CONCURRENCY) {
    const batch = users.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((u) => scrapeForUser(u.id)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      results.push(s.status === "fulfilled" ? s.value : { user_id: batch[j].id, error: String(s.reason) });
    }
  }

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

  return Response.json({
    processed: users.length,
    results,
    onboarding,
    engagement,
    timestamp: new Date().toISOString(),
  });
}
