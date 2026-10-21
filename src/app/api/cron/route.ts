import { createServiceClient } from "@/lib/supabase/server";
import { syncUserGmail } from "@/lib/gmail-sync";
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
  // Fail closed. This check used to be skipped entirely when CRON_SECRET was
  // unset, which made a route that emails every user callable by anyone, and
  // production had no CRON_SECRET on 2026-10-20. Until one is set on Vercel,
  // the manual trigger is off rather than open.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "CRON_SECRET is not set on this deployment" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Gmail sync first, so application statuses are fresh before any email goes
  // out. In-process, the way the admin actions route does it, and the same as
  // the emails job. This used to be a fetch back to our own /api/gmail/sync,
  // which src/proxy.ts redirected to /login every time: the request carried no
  // session cookie and that path is not on the proxy's public list, so the
  // daily sync had never actually run (confirmed 2026-10-20).
  const svc = createServiceClient();
  const { data: gmailUsers, error: gmailError } = await svc
    .from("profiles")
    .select("id")
    .eq("gmail_connected", true)
    .eq("onboarded", true);
  let gmailSync: Record<string, unknown>;
  if (gmailError) {
    gmailSync = { error: gmailError.message };
  } else {
    const settled = await Promise.allSettled((gmailUsers ?? []).map((u) => syncUserGmail(svc, u.id)));
    gmailSync = {
      users: settled.length,
      synced: settled.filter((r) => r.status === "fulfilled" && !r.value.error && !r.value.skipped).length,
      skipped: settled.filter((r) => r.status === "fulfilled" && r.value.skipped).length,
      failed: settled.filter((r) => r.status === "rejected" || r.value.error).length,
    };
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
