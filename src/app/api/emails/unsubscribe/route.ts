import { createServiceClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Public unsubscribe endpoint. Takes a per-user token (stored on profiles)
 * so users can opt out directly from an email footer without signing in.
 *
 * We never reveal whether a token is valid — always return the same friendly
 * page so this endpoint can't be used to enumerate accounts.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token")?.trim() || "";

  if (token) {
    const svc = createServiceClient();
    // Idempotent: we just set the flag; no-op if already opted out.
    await svc
      .from("profiles")
      .update({ emails_opted_out: true })
      .eq("unsubscribe_token", token);
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Unsubscribed — Autopilot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
  <div style="max-width:480px;margin:80px auto;padding:32px;background:#fff;border:1px solid #eaeaea;border-radius:12px;">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#888;margin-bottom:24px;">Autopilot</div>
    <h1 style="font-size:22px;margin:0 0 12px;">You&apos;re unsubscribed</h1>
    <p style="font-size:15px;line-height:1.6;color:#333;">You won&apos;t receive any more emails from Autopilot. Your account and jobs are untouched — we&apos;ll just stop showing up in your inbox.</p>
    <p style="font-size:14px;color:#666;margin-top:24px;">Changed your mind? You can toggle notifications back on in <a href="/settings" style="color:#111;">Settings</a>.</p>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
