import { processOnboardingReminders, processEngagementEmails, processDailyDigest } from "@/lib/email-campaigns";

// Manual trigger for the daily emails. Nothing schedules this route any more.
//
// The Vercel cron that hit it at 13:00 UTC was removed from vercel.json on
// 2026-10-20. It drove a scrape loop against a hosted scraper that no longer
// exists, and it ran hours before the GitHub Actions ingest finished, so every
// digest it sent described yesterday's jobs. Ingest now runs as sharded jobs
// in .github/workflows/ingest.yml, and the same workflow's emails job runs
// scripts/ingest/emails.ts once the shards are done. That script is the daily
// path; this route stays so the same campaigns can be fired by hand:
//
//   curl -H "Authorization: Bearer $CRON_SECRET" https://autopilot.ahdahzeh.com/api/cron
//
// Each campaign owns its throttle on the profile (onboarding_reminder_last_at,
// engagement_email_last_at, digest_email_last_at), so firing this after the
// workflow has already run sends nothing twice.
export const dynamic = "force-dynamic";
// Three campaigns, each listing every auth user and querying per profile,
// plus the Gmail sync, take minutes at 60 users, well past the 60s default.
export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Gmail sync first, so application statuses are fresh before any email goes
  // out. Internal fetch back to our own sync endpoint, same as the emails job.
  let gmailSync: string;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    gmailSync = res.ok ? "ok" : `HTTP ${res.status}`;
  } catch (err) {
    console.error("Gmail sync failed:", err);
    gmailSync = `failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Onboarding reminders for stuck users, engagement nudges for active users,
  // then the daily digest. Each pass writes its own throttle state on the
  // profile so we never double-send.
  const onboarding = await processOnboardingReminders().catch((err) => ({ error: String(err) }));
  const engagement = await processEngagementEmails().catch((err) => ({ error: String(err) }));
  const digest = await processDailyDigest().catch((err) => ({ error: String(err) }));

  return Response.json({
    gmail_sync: gmailSync,
    onboarding,
    engagement,
    digest,
    timestamp: new Date().toISOString(),
  });
}
