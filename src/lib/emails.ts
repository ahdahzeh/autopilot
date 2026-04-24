/**
 * Email sending + templates for onboarding reminders and engagement nudges.
 *
 * All email goes through Resend via fetch (no SDK dep, matches subscribe/route.ts).
 * Sender is `hello@autopilot.ahdahzeh.com` — the domain must be verified in
 * Resend before this will actually deliver. If RESEND_API_KEY is missing the
 * sender is a no-op, so local/dev never accidentally ships mail.
 */

const FROM = "Autopilot <hello@autopilot.ahdahzeh.com>";
const REPLY_TO = "adaze.oviawe@gmail.com";

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export async function sendEmail(payload: EmailPayload): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[emails] RESEND_API_KEY not set — skipping send to", payload.to);
    return { ok: false, error: "resend not configured" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: payload.to,
      reply_to: REPLY_TO,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[emails] resend rejected", res.status, body);
    return { ok: false, error: `resend ${res.status}: ${body}` };
  }
  return { ok: true };
}

// ─── Shared layout ──────────────────────────────────────────────────────────

function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://autopilot.ahdahzeh.com").replace(/\/+$/, "");
  return `${base}${path}`;
}

function unsubscribeUrl(token: string): string {
  return appUrl(`/api/emails/unsubscribe?token=${encodeURIComponent(token)}`);
}

function wrapHtml(opts: {
  previewText: string;
  bodyHtml: string;
  unsubscribeToken: string;
}): string {
  // Inline styles only — most clients strip <style> blocks.
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>Autopilot</title></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
  <div style="display:none;max-height:0;overflow:hidden;">${opts.previewText}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #eaeaea;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#888;margin-bottom:24px;">Autopilot</div>
          ${opts.bodyHtml}
          <div style="margin-top:40px;padding-top:24px;border-top:1px solid #eaeaea;font-size:12px;color:#888;line-height:1.6;">
            Sent by Autopilot. Reply to this email and a human will read it.<br/>
            <a href="${unsubscribeUrl(opts.unsubscribeToken)}" style="color:#888;">Unsubscribe from all emails</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr><td style="background:#111;border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:14px 24px;color:#fff;font-size:14px;font-weight:600;text-decoration:none;">${label}</a>
    </td></tr>
  </table>`;
}

// ─── Onboarding reminders ───────────────────────────────────────────────────

type OnboardingReminderInput = {
  to: string;
  firstName: string;
  unsubscribeToken: string;
  attempt: 1 | 2 | 3;
};

const ONBOARDING_COPY: Record<1 | 2 | 3, { subject: (n: string) => string; preview: string; greet: string; body: string; cta: string }> = {
  1: {
    subject: (n) => `Your Autopilot is almost ready${n ? `, ${n}` : ""}`,
    preview: "Finishing setup takes about 90 seconds.",
    greet: "Hey {NAME} 👋",
    body: `Thanks for signing up for Autopilot — we're excited to help you land your next role.<br/><br/>
      You got partway through setup, and we saved your progress. Finishing takes about 90 seconds and then Autopilot starts surfacing fresh jobs for you every morning.`,
    cta: "Finish setup",
  },
  2: {
    subject: () => `Still here when you're ready`,
    preview: "Your partial setup is waiting.",
    greet: "Hey {NAME},",
    body: `Just checking in — your Autopilot is still saved and ready whenever you have 90 seconds to finish.<br/><br/>
      Once it's set up, we scrape 8 job boards every morning at 9 AM ET and surface the best matches for you. No searching, no tabs, no endless scrolling.`,
    cta: "Finish setup",
  },
  3: {
    subject: () => `One last nudge — then we'll leave you alone`,
    preview: "Final reminder to finish setting up Autopilot.",
    greet: "Hey {NAME},",
    body: `This is the last email we'll send about finishing setup. No hard feelings either way — we know timing matters.<br/><br/>
      If now's not the right time, all good. Your data is safe if you come back later. If you want, reply and tell us what got in the way — it genuinely helps us make Autopilot better.`,
    cta: "Pick up where I left off",
  },
};

export function renderOnboardingReminder(input: OnboardingReminderInput): EmailPayload {
  const copy = ONBOARDING_COPY[input.attempt];
  const name = input.firstName.trim() || "there";
  const subject = copy.subject(name === "there" ? "" : name);
  const greetLine = copy.greet.replace("{NAME}", name);
  const cta = appUrl("/login?redirect=/onboarding");

  const html = wrapHtml({
    previewText: copy.preview,
    unsubscribeToken: input.unsubscribeToken,
    bodyHtml: `
      <p style="font-size:18px;font-weight:600;margin:0 0 12px;">${greetLine}</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 12px;color:#333;">${copy.body}</p>
      ${button(copy.cta, cta)}
      <p style="font-size:13px;color:#888;margin:24px 0 0;">— Adaze</p>
    `,
  });

  const text = `${greetLine}\n\n${copy.body.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")}\n\n${copy.cta}: ${cta}\n\n— Adaze\n\nUnsubscribe: ${unsubscribeUrl(input.unsubscribeToken)}`;

  return { to: input.to, subject, html, text };
}

// ─── Engagement: digest ─────────────────────────────────────────────────────

export type DigestJob = {
  title: string;
  company: string;
  match_score: number | null;
  url: string;
};

export type DigestInput = {
  to: string;
  firstName: string;
  unsubscribeToken: string;
  jobs: DigestJob[];
  periodLabel: string; // e.g. "this week"
};

export function renderDigest(input: DigestInput): EmailPayload {
  const name = input.firstName.trim() || "there";
  const count = input.jobs.length;
  const subject = count > 0
    ? `${count} new job${count === 1 ? "" : "s"} matched your profile ${input.periodLabel}`
    : `Your Autopilot digest for ${input.periodLabel}`;
  const preview = count > 0
    ? `Top matches handpicked for you.`
    : "A quick check-in.";

  const jobsHtml = input.jobs.slice(0, 5).map((j) => {
    const score = j.match_score != null ? `<span style="font-family:ui-monospace,monospace;font-size:11px;color:#666;background:#f5f5f5;padding:2px 6px;border-radius:4px;">${j.match_score}/10</span>` : "";
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #eaeaea;">
      <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${escapeHtml(j.title)}</div>
      <div style="font-size:13px;color:#666;margin-bottom:6px;">${escapeHtml(j.company)} &nbsp; ${score}</div>
      <a href="${j.url}" style="font-size:13px;color:#111;text-decoration:underline;">View job →</a>
    </td></tr>`;
  }).join("");

  const html = wrapHtml({
    previewText: preview,
    unsubscribeToken: input.unsubscribeToken,
    bodyHtml: `
      <p style="font-size:18px;font-weight:600;margin:0 0 12px;">Hey ${name} 👋</p>
      ${count > 0
        ? `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;color:#333;">Here are the top matches from your queue ${input.periodLabel}. Pick one and we'll tailor your resume for it in seconds.</p>
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${jobsHtml}</table>
           ${button("Open dashboard", appUrl("/"))}`
        : `<p style="font-size:15px;line-height:1.6;margin:0 0 12px;color:#333;">The scrapers have been a little quiet ${input.periodLabel}. Worth popping into Settings and widening your locations or titles — the pool opens up fast with a couple tweaks.</p>
           ${button("Open Settings", appUrl("/settings"))}`
      }
      <p style="font-size:13px;color:#888;margin:24px 0 0;">— Adaze</p>
    `,
  });

  const jobsText = input.jobs.slice(0, 5).map((j) => `• ${j.title} @ ${j.company}${j.match_score != null ? ` (${j.match_score}/10)` : ""}\n  ${j.url}`).join("\n\n");
  const text = `Hey ${name},\n\n${count > 0
    ? `Here are your top matches ${input.periodLabel}:\n\n${jobsText}\n\nDashboard: ${appUrl("/")}`
    : `The scrapers were quiet ${input.periodLabel}. Worth widening your titles or locations in Settings: ${appUrl("/settings")}`
  }\n\n— Adaze\n\nUnsubscribe: ${unsubscribeUrl(input.unsubscribeToken)}`;

  return { to: input.to, subject, html, text };
}

// ─── Daily digest (top 5 Haiku-scored matches from last 24h) ────────────────

export type DailyDigestJob = {
  id: string;
  title: string;
  company: string;
  match_score: number | null;
  score_reasoning: string;
};

export type DailyDigestInput = {
  to: string;
  firstName: string;
  unsubscribeToken: string;
  jobs: DailyDigestJob[];
};

function scorePill(score: number | null): string {
  // Monospace score pill. Green >=80, orange 50-79, grey below.
  if (score == null) {
    return `<span style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#666;background:#f0f0f0;padding:3px 8px;border-radius:4px;letter-spacing:.02em;">—</span>`;
  }
  let bg = "#f0f0f0";
  let fg = "#666";
  if (score >= 80) { bg = "#d6f5e0"; fg = "#0a6b2e"; }
  else if (score >= 50) { bg = "#ffe8cc"; fg = "#8a4a00"; }
  return `<span style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:${fg};background:${bg};padding:3px 8px;border-radius:4px;letter-spacing:.02em;">${score}</span>`;
}

export function renderDailyDigest(input: DailyDigestInput): EmailPayload {
  const name = input.firstName.trim() || "there";
  const subject = "Your top 5 matches today";
  const preview = "Handpicked matches from the last 24 hours.";

  const jobsHtml = input.jobs.map((j) => {
    const link = `${appUrl("/")}?job=${encodeURIComponent(j.id)}`;
    return `<tr><td style="padding:16px 0;border-bottom:1px solid #eaeaea;">
      <div style="font-size:15px;font-weight:700;color:#111;margin-bottom:4px;">${escapeHtml(j.title)}</div>
      <div style="font-size:13px;color:#555;margin-bottom:8px;">${escapeHtml(j.company)} &nbsp; ${scorePill(j.match_score)}</div>
      <div style="font-size:12px;font-style:italic;color:#888;line-height:1.5;margin-bottom:10px;">${escapeHtml(j.score_reasoning)}</div>
      <a href="${link}" style="font-size:13px;color:#111;text-decoration:underline;font-weight:600;">View →</a>
    </td></tr>`;
  }).join("");

  const html = wrapHtml({
    previewText: preview,
    unsubscribeToken: input.unsubscribeToken,
    bodyHtml: `
      <p style="font-size:18px;font-weight:600;margin:0 0 12px;color:#111;">Hey ${name},</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 16px;color:#333;">Your top matches from the last 24 hours, ranked by fit.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${jobsHtml}</table>
      ${button("Open dashboard", appUrl("/"))}
      <p style="font-size:13px;color:#888;margin:24px 0 0;">— Adaze</p>
    `,
  });

  const jobsText = input.jobs.map((j) => {
    const link = `${appUrl("/")}?job=${encodeURIComponent(j.id)}`;
    const scoreText = j.match_score != null ? ` [${j.match_score}]` : "";
    return `• ${j.title} @ ${j.company}${scoreText}\n  ${j.score_reasoning}\n  ${link}`;
  }).join("\n\n");
  const text = `Hey ${name},\n\nYour top matches from the last 24 hours:\n\n${jobsText}\n\nDashboard: ${appUrl("/")}\n\n— Adaze\n\nUnsubscribe: ${unsubscribeUrl(input.unsubscribeToken)}`;

  return { to: input.to, subject, html, text };
}

// ─── Engagement: spotlight ──────────────────────────────────────────────────

export type SpotlightInput = {
  to: string;
  firstName: string;
  unsubscribeToken: string;
  job: DigestJob;
};

export function renderSpotlight(input: SpotlightInput): EmailPayload {
  const name = input.firstName.trim() || "there";
  const score = input.job.match_score != null ? input.job.match_score : null;
  const subject = score != null
    ? `Your top match this week scored ${score}/10`
    : `A job we thought you'd like`;

  const html = wrapHtml({
    previewText: `${input.job.title} at ${input.job.company}`,
    unsubscribeToken: input.unsubscribeToken,
    bodyHtml: `
      <p style="font-size:18px;font-weight:600;margin:0 0 12px;">Hey ${name} 👋</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:#333;">One job stood out from your queue this week. Worth a look:</p>
      <div style="background:#fafafa;border:1px solid #eaeaea;border-radius:8px;padding:20px;margin-bottom:20px;">
        <div style="font-size:17px;font-weight:600;margin-bottom:6px;">${escapeHtml(input.job.title)}</div>
        <div style="font-size:14px;color:#666;margin-bottom:12px;">${escapeHtml(input.job.company)}</div>
        ${score != null ? `<div style="display:inline-block;font-family:ui-monospace,monospace;font-size:12px;color:#0a0;background:#e8f5e9;padding:4px 10px;border-radius:4px;">Match score ${score}/10</div>` : ""}
      </div>
      <p style="font-size:14px;line-height:1.6;margin:0 0 8px;color:#444;">Open it in your dashboard and we'll tailor your resume + generate a cover letter in about 30 seconds.</p>
      ${button("Open & tailor", input.job.url)}
      <p style="font-size:13px;color:#888;margin:24px 0 0;">— Adaze</p>
    `,
  });

  const text = `Hey ${name},\n\nOne job stood out from your queue this week:\n\n${input.job.title}\n${input.job.company}${score != null ? `\nMatch score: ${score}/10` : ""}\n\n${input.job.url}\n\n— Adaze\n\nUnsubscribe: ${unsubscribeUrl(input.unsubscribeToken)}`;

  return { to: input.to, subject, html, text };
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function firstNameOf(displayName?: string | null, email?: string | null): string {
  const n = (displayName || "").trim().split(/\s+/)[0];
  if (n) return n;
  const e = (email || "").split("@")[0] || "";
  // Strip numbers and punctuation, title-case
  const clean = e.replace(/[._\-0-9]+/g, " ").trim().split(/\s+/)[0] || "";
  return clean ? clean[0].toUpperCase() + clean.slice(1).toLowerCase() : "";
}
