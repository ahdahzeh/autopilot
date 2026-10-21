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

import { createHash } from "node:crypto";
import { createServiceClient } from "./supabase/server";
import {
  renderOnboardingReminder,
  renderDigest,
  renderSpotlight,
  renderDailyDigest,
  sendEmail,
  firstNameOf,
  type DigestJob,
  type DailyDigestJob,
} from "./emails";
import { captureError } from "./sentry";

// listUsers() returns one page of 50 by default. With 33 users that was every
// account, but the Per Scholas cohort pushes the total past 50, and every user
// on a later page would have been silently skipped by all three campaigns.
async function loadEmailsById(svc: ReturnType<typeof createServiceClient>): Promise<Record<string, string>> {
  const emailById: Record<string, string> = {};
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`list auth users page ${page}: ${error.message}`);
    const users = data?.users ?? [];
    for (const u of users) emailById[u.id] = (u.email || "").trim();
    if (users.length < perPage) return emailById;
  }
}

// GitHub Actions logs are public, so log lines and error summaries name a user
// by a short hash of their id, never their email address.
function userTag(id: string): string {
  return `user:${createHash("sha1").update(id).digest("hex").slice(0, 8)}`;
}

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
  const emailById = await loadEmailsById(svc);

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
      summary.errors.push(`${userTag(p.id)}: ${result.error ?? "send failed"}`);
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

// ─── Daily digest (top 5 Haiku-scored matches from the last 24h) ────────────
//
// Runs alongside the other two campaigns. Targets onboarded users with an
// active Gmail connection (gmail_connected=true) and who have at least 3
// scored matches in the last 24h — a 1- or 2-job digest isn't worth an email.
// Throttled via profiles.digest_email_last_at to one send per run.
//
// The gap was 20 hours, but the digest now runs after GitHub Actions ingest,
// whose scheduled start drifts by 3 to 6 hours. Two consecutive runs can land
// 18 hours apart, and a 20 hour gap would skip that day's digest. 14 hours
// still blocks a same-day double send from a manual rerun.

const DIGEST_MIN_MATCHES = 3;
const DIGEST_MIN_HOURS_BETWEEN_SENDS = 14;
const DIGEST_WINDOW_HOURS = 24;

export async function processDailyDigest(): Promise<CampaignSummary> {
  const svc = createServiceClient();
  const summary: CampaignSummary = { eligible: 0, sent: 0, skipped: 0, errors: [] };

  // Onboarded + opted-in + Gmail connected only. Skip unverified users.
  const { data: profiles, error } = await svc
    .from("profiles")
    .select("id, display_name, digest_email_last_at, emails_opted_out, unsubscribe_token, gmail_connected")
    .eq("onboarded", true)
    .eq("emails_opted_out", false)
    .eq("gmail_connected", true);

  if (error || !profiles) {
    summary.errors.push(`fetch profiles: ${error?.message ?? "unknown"}`);
    return summary;
  }

  const emailById = await loadEmailsById(svc);

  const now = Date.now();
  const since = new Date(now - DIGEST_WINDOW_HOURS * 3600_000).toISOString();

  for (const p of profiles) {
    summary.eligible += 1;

    // Throttle: under DIGEST_MIN_HOURS_BETWEEN_SENDS since the last digest means skip.
    if (p.digest_email_last_at) {
      const hoursSince = (now - new Date(p.digest_email_last_at).getTime()) / 3600_000;
      if (hoursSince < DIGEST_MIN_HOURS_BETWEEN_SENDS) { summary.skipped += 1; continue; }
    }

    const email = emailById[p.id];
    if (!email) { summary.skipped += 1; continue; }
    if (!p.unsubscribe_token) { summary.skipped += 1; continue; }

    // Top 5 Haiku-scored jobs from the last 24h with a real apply link.
    // score_reasoning must be non-null — we don't send "see these jobs"
    // emails if we can't show why they fit.
    const { data: jobs } = await svc
      .from("jobs")
      .select("id, title, company, match_score, score_reasoning, apply_link")
      .eq("user_id", p.id)
      .gte("created_at", since)
      .not("score_reasoning", "is", null)
      .order("match_score", { ascending: false, nullsFirst: false })
      .limit(10); // fetch extra so filtering empty apply_link still yields 5

    const eligibleJobs: DailyDigestJob[] = (jobs ?? [])
      .filter((j) => typeof j.apply_link === "string" && j.apply_link.trim() !== "")
      .filter((j) => typeof j.score_reasoning === "string" && j.score_reasoning.trim() !== "")
      .slice(0, 5)
      .map((j) => ({
        id: j.id,
        title: j.title ?? "Untitled",
        company: j.company ?? "—",
        match_score: j.match_score ?? null,
        score_reasoning: j.score_reasoning as string,
      }));

    if (eligibleJobs.length < DIGEST_MIN_MATCHES) {
      console.log(`[daily-digest] skip ${userTag(p.id)}: only ${eligibleJobs.length} eligible match${eligibleJobs.length === 1 ? "" : "es"}`);
      summary.skipped += 1;
      continue;
    }

    const payload = renderDailyDigest({
      to: email,
      firstName: firstNameOf(p.display_name, email),
      unsubscribeToken: p.unsubscribe_token,
      jobs: eligibleJobs,
    });

    try {
      const result = await sendEmail(payload);
      if (!result.ok) {
        captureError(new Error(`daily digest send failed: ${result.error ?? "unknown"}`), { user: userTag(p.id) });
        summary.errors.push(`${userTag(p.id)}: ${result.error ?? "send failed"}`);
        continue;
      }
    } catch (err) {
      captureError(err, { user: userTag(p.id), scope: "daily-digest-send" });
      summary.errors.push(`${userTag(p.id)}: ${String(err)}`);
      continue;
    }

    await svc.from("profiles").update({
      digest_email_last_at: new Date().toISOString(),
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

  const emailById = await loadEmailsById(svc);

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
      summary.errors.push(`${userTag(p.id)}: ${result.error ?? "send failed"}`);
      continue;
    }

    await svc.from("profiles").update({
      engagement_email_last_at: new Date().toISOString(),
    }).eq("id", p.id);

    summary.sent += 1;
  }

  return summary;
}
