import { createClient, createServiceClient } from "@/lib/supabase/server";
import { syncUserGmail } from "@/lib/gmail-sync";
import { scrapeForUser } from "@/lib/scrape";
import { processOnboardingReminders, processEngagementEmails } from "@/lib/email-campaigns";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  return profile?.is_admin ? user : null;
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { action, userId } = body as { action?: string; userId?: string };

  const svc = createServiceClient();

  // Batch email campaign actions — no per-user target, they sweep all
  // eligible users using the same logic the daily cron runs.
  if (action === "send_onboarding_reminders") {
    const result = await processOnboardingReminders();
    return Response.json(result);
  }

  if (action === "send_engagement_emails") {
    const result = await processEngagementEmails();
    return Response.json(result);
  }

  if (!userId) {
    return Response.json({ error: "userId required" }, { status: 400 });
  }

  if (action === "sync_gmail") {
    const result = await syncUserGmail(svc, userId);
    return Response.json(result);
  }

  if (action === "scrape") {
    // Verify the target user is onboarded before scraping
    const { data: profile } = await svc
      .from("profiles")
      .select("onboarded, target_titles, target_locations")
      .eq("id", userId)
      .single();

    if (!profile?.onboarded) {
      return Response.json({ error: "User not onboarded" }, { status: 400 });
    }

    try {
      const result = await scrapeForUser(userId);
      return Response.json(result);
    } catch (err) {
      console.error("[admin/actions] scrape failed", err);
      return Response.json(
        { error: err instanceof Error ? err.message : "Scrape failed" },
        { status: 500 },
      );
    }
  }

  return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
