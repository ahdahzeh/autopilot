/**
 * Daily emails, run from GitHub Actions once every ingest shard has finished.
 *
 * The Vercel cron used to send these at 13:00 UTC, which was hours before
 * ingest finished (the 13:00 ingest run started between 16:01 and 18:53 UTC on
 * 2026-10-16..20 and then took 48 to 54 minutes), so every digest described
 * yesterday's jobs. The emails job in .github/workflows/ingest.yml needs the
 * shard jobs and runs this script after them, with always() so one dead shard
 * does not stop everyone's digest.
 *
 * Order matches the old cron route: Gmail sync first so application statuses
 * are fresh, then onboarding reminders, engagement nudges and the daily digest.
 * The campaigns themselves live in src/lib/email-campaigns.ts and own their
 * throttles (onboarding_reminder_last_at, engagement_email_last_at,
 * digest_email_last_at on profiles), so running this twice in a day is safe.
 *
 *   npx tsx scripts/ingest/emails.ts
 *   DRY_RUN=1 npx tsx scripts/ingest/emails.ts   # no email leaves, no row is written
 *
 * Environment (every variable the campaign code path reads):
 *   NEXT_PUBLIC_SUPABASE_URL     required, createServiceClient() in src/lib/supabase/server.ts
 *   SUPABASE_SERVICE_ROLE_KEY    required, same
 *   RESEND_API_KEY               required unless DRY_RUN=1; sendEmail() in src/lib/emails.ts
 *   NEXT_PUBLIC_APP_URL          links in every email (src/lib/emails.ts, email-campaigns.ts)
 *                                and the Gmail sync target; defaults to
 *                                https://autopilot.ahdahzeh.com like the lib does
 *   CRON_SECRET                  optional; bearer token for the Gmail sync, must equal the
 *                                Vercel env var of the same name. The sync is attempted
 *                                without it, since the site only checks it when it has one.
 *   NEXT_PUBLIC_SENTRY_DSN       optional; captureError() in src/lib/sentry.ts falls back to
 *                                console.error without it (and @sentry/nextjs is not installed)
 *   INGEST_RESULT                optional; the workflow passes needs.ingest.result for the summary
 *   DRY_RUN=1                    see main()
 *
 * The Actions log is public, because the repo is. Every console call is
 * filtered before it reaches stdout: email addresses and user ids become
 * 8-character hashes (the same hash run.ts uses, so one grep finds a user in
 * both jobs). This is load-bearing, not cosmetic: processDailyDigest logs
 * "[daily-digest] skip <email>", sendEmail() logs "skipping send to <email>",
 * captureError's console fallback prints { email, userId }, and every
 * campaign's errors list starts with the address.
 */
import { createHash } from "node:crypto";
import { format } from "node:util";

const DRY_RUN = process.env.DRY_RUN === "1";
const GMAIL_SYNC_TIMEOUT_MS = 120_000;

// ─── Public-log redaction ───────────────────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** First 8 hex characters of sha1(value). Must stay identical to shortHash in run.ts. */
function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function redact(text: string): string {
  return text
    .replace(UUID_RE, (id) => `user:${shortHash(id.toLowerCase())}`)
    .replace(EMAIL_RE, (email) => `email:${shortHash(email.toLowerCase())}`);
}

/**
 * Wrap every console method so anything the campaigns (or their libraries)
 * print goes through redact(). util.format renders objects the way console
 * would, so `console.error("[autopilot]", { email, userId }, err)` still reads
 * the same, minus the address and the id.
 */
function installLogFilter(): void {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(redact(format(...args)));
  }
}

// ─── Gmail sync (what the cron route did between the scrape loop and the emails) ──

/**
 * The cron route ran the live site's Gmail sync before the campaigns so the
 * digest saw fresh application statuses; this keeps that order. The sync route
 * only enforces CRON_SECRET when the Vercel env var is set (it was not on
 * 2026-10-20), so the call goes out either way: without a token it is a 200
 * where Vercel has no secret, and a 401 that names the missing repository
 * secret where it has one. Best effort, like the route: a failed sync is a
 * log line, not a red job, because the digest still has yesterday's statuses.
 */
async function syncGmail(appUrl: string): Promise<string> {
  // The sync writes application statuses to profiles and jobs.
  if (DRY_RUN) return "skipped: DRY_RUN";
  const secret = process.env.CRON_SECRET;
  const token = secret ? "with CRON_SECRET" : "without CRON_SECRET";
  try {
    const res = await fetch(`${appUrl}/api/gmail/sync`, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(GMAIL_SYNC_TIMEOUT_MS),
    });
    if (res.status === 401) {
      return secret
        ? `failed: HTTP 401 ${token} (the repository secret does not match Vercel's CRON_SECRET)`
        : `failed: HTTP 401 ${token} (add a CRON_SECRET repository secret equal to Vercel's)`;
    }
    if (!res.ok) return `failed: HTTP ${res.status} ${token}`;
    // The body also carries per-user results keyed by user id; only the count is worth printing.
    const data = (await res.json().catch(() => ({}))) as { processed?: number };
    return `ok: ${data.processed ?? 0} users ${token}`;
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)} ${token}`;
  }
}

// ─── Campaigns ──────────────────────────────────────────────────────────────

type CampaignSummary = { eligible: number; sent: number; skipped: number; errors: string[] };
type CampaignOutcome = CampaignSummary & { name: string; threw?: string };

// What sendEmail() returns when RESEND_API_KEY is unset. In DRY_RUN every
// would-be send ends up in errors with this text, which is how the dry run
// counts them without the campaigns knowing it is a dry run.
const NOT_CONFIGURED = "resend not configured";

async function runCampaign(name: string, fn: () => Promise<CampaignSummary>): Promise<CampaignOutcome> {
  const started = Date.now();
  try {
    const summary = await fn();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (DRY_RUN) {
      const wouldSend = summary.errors.filter((e) => e.endsWith(NOT_CONFIGURED)).length;
      const realErrors = summary.errors.filter((e) => !e.endsWith(NOT_CONFIGURED));
      console.log(
        `${name}: eligible ${summary.eligible}, would send ${wouldSend}, skipped ${summary.skipped}, errors ${realErrors.length} (${seconds}s, dry run)`,
      );
      for (const e of realErrors) console.log(`  ${e}`);
      return { name, ...summary, errors: realErrors };
    }
    console.log(
      `${name}: eligible ${summary.eligible}, sent ${summary.sent}, skipped ${summary.skipped}, errors ${summary.errors.length} (${seconds}s)`,
    );
    // Each entry is "<address>: <reason>"; the log filter hashes the address.
    for (const e of summary.errors) console.log(`  ${e}`);
    return { name, ...summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`${name}: threw: ${message}`);
    return { name, eligible: 0, sent: 0, skipped: 0, errors: [], threw: message };
  }
}

async function main(): Promise<void> {
  installLogFilter();

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  // A missing key would not crash the campaigns: sendEmail() would log one
  // "skipping send" line per recipient and the job would go green having sent
  // nothing. Fail before touching the database instead, so a missing secret
  // is a red job and not a quiet week of no digests.
  if (!process.env.RESEND_API_KEY && !DRY_RUN) {
    throw new Error("RESEND_API_KEY is required (set DRY_RUN=1 to run without sending)");
  }

  if (DRY_RUN) {
    // DRY_RUN works by taking RESEND_API_KEY away before the campaigns read it.
    // sendEmail() (src/lib/emails.ts) reads the key per call and returns
    // { ok: false, error: "resend not configured" } without touching the
    // network when it is missing, and all three campaigns `continue` on
    // !result.ok before their profiles.update(), so no email leaves and no
    // throttle timestamp is written. The remaining side effect would be
    // captureError() in processDailyDigest; without NEXT_PUBLIC_SENTRY_DSN it
    // is a console.error, which the log filter redacts.
    delete process.env.RESEND_API_KEY;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    console.log("emails: DRY_RUN=1, no email will be sent and no profile row will be updated");
  }

  // Imported after the DRY_RUN edits so no module can snapshot the key at load
  // time. (Today none does, but the ordering costs nothing.)
  const { processOnboardingReminders, processEngagementEmails, processDailyDigest } = await import(
    "../../src/lib/email-campaigns"
  );

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://autopilot.ahdahzeh.com").replace(/\/+$/, "");
  if (process.env.INGEST_RESULT) console.log(`emails: ingest result was "${process.env.INGEST_RESULT}"`);
  console.log(`emails: links point at ${appUrl}`);

  console.log(`gmail sync: ${await syncGmail(appUrl)}`);

  const outcomes = [
    await runCampaign("onboarding reminders", processOnboardingReminders),
    await runCampaign("engagement nudges", processEngagementEmails),
    await runCampaign("daily digest", processDailyDigest),
  ];

  const sent = outcomes.reduce((n, o) => n + o.sent, 0);
  const failed = outcomes.reduce((n, o) => n + o.errors.length, 0);
  const threw = outcomes.filter((o) => o.threw).map((o) => o.name);
  console.log(
    `emails done: ${DRY_RUN ? "dry run, " : ""}${sent} sent, ${failed} failed, ${threw.length} campaign${threw.length === 1 ? "" : "s"} threw`,
  );

  if (threw.length > 0) {
    throw new Error(`campaigns threw: ${threw.join(", ")}`);
  }
  // Same rule as ingest: most sends failing means Resend or the key is broken,
  // and that must go red rather than trickle one error line into a green log.
  const attempted = sent + failed;
  if (!DRY_RUN && attempted > 0 && failed * 2 > attempted) {
    throw new Error(`${failed} of ${attempted} sends failed, failing the job so the run goes red`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
