/**
 * Email campaign processors — called by the daily cron at 13:00 UTC.
 *
 * Two passes run after the scrape + Gmail sync:
 *   1. processOnboardingReminders() — targets onboarded=false users, sends
 *      day 1 / day 3 / day 7 reminders, max 3 per user, stops on opt-out or
 *      completion of onboarding.
 *   2. processEngagementEmails() — targets onboarded=true users, randomly
 *      picks between digest + spotlight formats, enforces a 3-day minimum
 *      gap, probabilistically fires so cadence averages ~1.5×/week.
 *
 * Both honor `profiles.emails_opted_out`.
 */

import { createServiceClient } from "./supabase/server";
import {
  renderOnboardingReminder,
  renderDigest,
  renderSpotlight,
  sendEmail,
  firstNameOf,
  type DigestJob,
} from "./emails";

type CampaignSummary = {
  eligible: number;
  sent: number;
  skipped: number;
  errors: string[];
};

// ─── Onboarding reminders ───────────────────────────────────────────────────

const ONBOARDING_CADENCE_DAYS = [1, 3, 7]; // day N after signup per attempt

export async function processOnboardingReminders(): Promise<CampaignSummary> {
  const svc = createServiceClient();
  const summary: CampaignSummary = { eligible: 0, sent: 0, skipped: 0, errors: [] };

  // Fetch all not-yet-onboarded profiles with reminder state.
  const { data: profiles, error } = await svc
    .from("profiles")
    .select("id, display_name, onboarding_reminder_count, onboarding_reminder_last_at, emails_opted_out, unsubscribe_token, created_at")
    .eq("onboarded", false);

  if (error || !profiles) {
    summary.errors.push(`fetch profiles: ${error?.message ?? "unknown"}`);
    return summary;
  }

  // Fetch auth emails via the service client admin API.
  const { data: authList } = await svc.auth.admin.listUsers();
  const emailById: Record<string, string> = {};
  for (const u of authList?.users ?? []) emailById[u.id] = (u.email || "").trim();

  const now = Date.now();

  for (const p of profiles) {
    summary.eligible += 1;

    if (p.emails_opted_out) { summary.skipped += 1; continue; }

    const count = p.onboarding_reminder_count ?? 0;
    if (count >= ONBOARDING_CADENCE_DAYS.length) { summary.skipped += 1; continue; }

    // Has enough time passed since signup (for the first reminder) or since
    // the last reminder?
    const daysSinceSignup = (now - new Date(p.created_at).getTime()) / 86400000;
    const expectedDay = ONBOARDING_CADENCE_DAYS[count]; // the day the NEXT attempt should go out (measured from signup)
    if (daysSinceSignup < expectedDay) { summary.skipped += 1; continue; }

    // Extra guard: don't send two reminders within 24h of each other.
    if (p.onboarding_reminder_last_at) {
      const hoursSinceLast = (now - new Date(p.onboarding_reminder_last_at).getTime()) / 3600000;
      if (hoursSinceLast < 24) { summary.skipped += 1; continue; }
    }

    const email = emailById[p.id];
    if (!email) { summary.skipped += 1; continue; }
    if (!p.unsubscribe_token) { summary.skipped += 1; continue; }

    const payload = renderOnboardingReminder({
      to: email,
      firstName: firstNameOf(p.display_name, email),
      unsubscribeToken: p.unsubscribe_token,
      attempt: (count + 1) as 1 | 2 | 3,
    });

    const result = await sendEmail(payload);
    if (!result.ok) {
      summary.errors.push(`${email}: ${result.error ?? "send failed"}`);
      continue;
    }

    await svc.from("profiles").update({
      onboarding_reminder_count: count + 1,
      onboarding_reminder_last_at: new Date().toISOString(),
    }).eq("id", p.id);

    summary.sent += 1;
  }

  return summary;
}

// ─── Engagement nudges ──────────────────────────────────────────────────────

const ENGAGEMENT_MIN_GAP_DAYS = 3;
const ENGAGEMENT_GUARANTEED_AFTER_DAYS = 7;
const ENGAGEMENT_PROBABILITY_IN_WINDOW = 0.4; // between min-gap and guaranteed, 40% chance per day → avg ~5-day cadence

export async function processEngagementEmails(): Promise<CampaignSummary> {
  const svc = createServiceClient();
  const summary: CampaignSummary = { eligible: 0, sent: 0, skipped: 0, errors: [] };

  const { data: profiles, error } = await svc
    .from("profiles")
    .select("id, display_name, engagement_email_last_at, emails_opted_out, unsubscribe_token")
    .eq("onboarded", true);

  if (error || !profiles) {
    summary.errors.push(`fetch profiles: ${error?.message ?? "unknown"}`);
    return summary;
  }

  const { data: authList } = await svc.auth.admin.listUsers();
  const emailById: Record<string, string> = {};
  for (const u of authList?.users ?? []) emailById[u.id] = (u.email || "").trim();

  const now = Date.now();

  for (const p of profiles) {
    summary.eligible += 1;
    if (p.emails_opted_out) { summary.skipped += 1; continue; }

    // Cadence gate. First-timers (no prior send) go immediately.
    if (p.engagement_email_last_at) {
      const daysSince = (now - new Date(p.engagement_email_last_at).getTime()) / 86400000;
      if (daysSince < ENGAGEMENT_MIN_GAP_DAYS) { summary.skipped += 1; continue; }
      if (daysSince < ENGAGEMENT_GUARANTEED_AFTER_DAYS) {
        if (Math.random() > ENGAGEMENT_PROBABILITY_IN_WINDOW) { summary.skipped += 1; continue; }
      }
    }

    const email = emailById[p.id];
    if (!email) { summary.skipped += 1; continue; }
    if (!p.unsubscribe_token) { summary.skipped += 1; continue; }

    // Pull last 7 days of the user's jobs, ranked by match_score desc.
    const since = new Date(now - 7 * 86400000).toISOString();
    const { data: jobs } = await svc
      .from("jobs")
      .select("id, title, company, match_score, url")
      .eq("user_id", p.id)
      .gte("created_at", since)
      .order("match_score", { ascending: false, nullsFirst: false })
      .limit(5);

    const digestJobs: DigestJob[] = (jobs ?? []).map((j) => ({
      title: j.title ?? "Untitled",
      company: j.company ?? "—",
      match_score: j.match_score ?? null,
      url: j.url ?? `${process.env.NEXT_PUBLIC_APP_URL || "https://autopilot.ahdahzeh.com"}/`,
    }));

    // 60% digest, 40% spotlight. Spotlight requires at least one job with a
    // real score; otherwise we fall back to digest (which handles empty state).
    const wantSpotlight = Math.random() < 0.4 && digestJobs.some((j) => j.match_score != null);

    const payload = wantSpotlight
      ? renderSpotlight({
          to: email,
          firstName: firstNameOf(p.display_name, email),
          unsubscribeToken: p.unsubscribe_token,
          job: digestJobs[0],
        })
      : renderDigest({
          to: email,
          firstName: firstNameOf(p.display_name, email),
          unsubscribeToken: p.unsubscribe_token,
          jobs: digestJobs,
          periodLabel: "this week",
        });

    const result = await sendEmail(payload);
    if (!result.ok) {
      summary.errors.push(`${email}: ${result.error ?? "send failed"}`);
      continue;
    }

    await svc.from("profiles").update({
      engagement_email_last_at: new Date().toISOString(),
    }).eq("id", p.id);

    summary.sent += 1;
  }

  return summary;
}
