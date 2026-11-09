import { createServiceClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/sentry";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Public unsubscribe endpoint. Takes a per-user token (stored on profiles)
 * so users can opt out directly from an email footer without signing in.
 *
 * GET only shows a page with one button: mail scanners open every link in a
 * message, and a GET that unsubscribed would opt people out unasked. POST does
 * the opt-out, from that button or from a mail client's RFC 8058 one-click
 * request (body List-Unsubscribe=One-Click, no cookies), which posts to the
 * List-Unsubscribe URL with the token still in the query string.
 *
 * We never reveal whether a token is valid: every token gets the same page,
 * so this endpoint can't be used to enumerate accounts.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token")?.trim() || "";
  const action = `/api/emails/unsubscribe?token=${encodeURIComponent(token)}`;

  return page(
    "Unsubscribe from Autopilot",
    `<h1 style="font-size:22px;margin:0 0 12px;">Unsubscribe from Autopilot</h1>
    <p style="font-size:15px;line-height:1.6;color:#333;">You&apos;ll stop getting every Autopilot email: digests, nudges and reminders. Your account and jobs stay as they are.</p>
    <form method="post" action="${action}" style="margin:24px 0 0;">
      <button type="submit" style="background:#111;color:#fff;border:0;border-radius:8px;padding:14px 24px;font-size:14px;font-weight:600;cursor:pointer;">Unsubscribe</button>
    </form>`,
  );
}

export async function POST(request: NextRequest) {
  let token = request.nextUrl.searchParams.get("token")?.trim() || "";
  if (!token) {
    const form = await request.formData().catch(() => null);
    const field = form?.get("token");
    token = typeof field === "string" ? field.trim() : "";
  }

  if (token) {
    const svc = createServiceClient();
    // Idempotent: we just set the flag; no-op if already opted out.
    const { error } = await svc
      .from("profiles")
      .update({ emails_opted_out: true })
      .eq("unsubscribe_token", token);
    if (error) {
      // No token in the log: it is the user's opt-out credential.
      captureError(new Error(`unsubscribe update failed: ${error.message}`), { route: "emails/unsubscribe" });
      return page(
        "Unsubscribe from Autopilot",
        `<h1 style="font-size:22px;margin:0 0 12px;">That didn&apos;t go through</h1>
        <p style="font-size:15px;line-height:1.6;color:#333;">We couldn&apos;t unsubscribe you just now. Try the link again in a minute, or reply to any Autopilot email and we&apos;ll do it by hand.</p>`,
        500,
      );
    }
  }

  return page(
    "Unsubscribed from Autopilot",
    `<h1 style="font-size:22px;margin:0 0 12px;">You&apos;re unsubscribed</h1>
    <p style="font-size:15px;line-height:1.6;color:#333;">You won&apos;t receive any more emails from Autopilot. Your account and jobs are untouched. We&apos;ll just stop showing up in your inbox.</p>
    <p style="font-size:14px;color:#666;margin-top:24px;">Changed your mind? Reply to any Autopilot email and we&apos;ll turn them back on.</p>`,
  );
}

function page(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex" />
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
  <div style="max-width:480px;margin:80px auto;padding:32px;background:#fff;border:1px solid #eaeaea;border-radius:12px;">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#888;margin-bottom:24px;">Autopilot</div>
    ${bodyHtml}
  </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
