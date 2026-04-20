import { createClient, createServiceClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

async function getValidAccessToken(userId: string): Promise<string | null> {
  const supabase = createServiceClient();

  const { data: tokens } = await supabase
    .from("gmail_tokens")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!tokens) return null;

  // Token still valid (5 min buffer)
  if (new Date(tokens.token_expiry) > new Date(Date.now() + 5 * 60 * 1000)) {
    return tokens.access_token;
  }

  // Refresh
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) return null;

  const refreshed = await res.json();
  const expiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

  await supabase.from("gmail_tokens").update({
    access_token: refreshed.access_token,
    token_expiry: expiry,
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);

  return refreshed.access_token;
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { company, role, dateApplied } = await request.json();
  if (!company || !role) {
    return Response.json({ error: "company and role are required" }, { status: 400 });
  }

  // Check gmail is connected
  const { data: profile } = await supabase
    .from("profiles")
    .select("gmail_connected, display_name")
    .eq("id", user.id)
    .single();

  if (!profile?.gmail_connected) {
    return Response.json({ error: "Gmail is not connected. Connect it in Settings." }, { status: 400 });
  }

  const accessToken = await getValidAccessToken(user.id);
  if (!accessToken) {
    return Response.json({ error: "Gmail token expired. Reconnect Gmail in Settings." }, { status: 400 });
  }

  const displayName = profile.display_name || "me";
  const appliedOn = dateApplied
    ? new Date(dateApplied).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "recently";

  const subject = `Following up on ${role} at ${company}`;
  const body = `Hi,

I wanted to follow up on my application for the ${role} position at ${company}. I applied on ${appliedOn} and remain very interested in this opportunity.

I'd love to learn more about the next steps in your process. Please let me know if there's anything else I can provide.

Best,
${displayName}`;

  // Build RFC 2822 MIME message
  const mimeMessage = [
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join("\r\n");

  const encoded = Buffer.from(mimeMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const draftRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { raw: encoded } }),
  });

  if (!draftRes.ok) {
    const err = await draftRes.json().catch(() => ({}));
    return Response.json({ error: err?.error?.message || "Failed to create draft" }, { status: 500 });
  }

  const draft = await draftRes.json();
  const draftUrl = `https://mail.google.com/mail/u/0/#drafts/${draft.id}`;

  return Response.json({ ok: true, draftId: draft.id, draftUrl });
}
