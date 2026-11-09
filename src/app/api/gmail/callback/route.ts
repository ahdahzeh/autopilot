import { createClient, createServiceClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { GMAIL_NONCE_COOKIE } from "@/lib/gmail-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const stateRaw = searchParams.get("state") || "{}";
  const error = searchParams.get("error");
  let nonce = "";
  let origin = "settings";
  try {
    const state = JSON.parse(stateRaw);
    nonce = typeof state.nonce === "string" ? state.nonce : "";
    origin = state.origin || "settings";
  } catch {
    // Not a state this app sent.
  }

  const failed = () => {
    const res = NextResponse.redirect(new URL("/settings?gmail=error", request.url));
    res.cookies.delete({ name: GMAIL_NONCE_COOKIE, path: "/api/gmail" });
    return res;
  };

  // The account is the signed-in one, never an id read from the URL: state
  // used to carry userId, unsigned, so a crafted link could store one
  // person's mailbox tokens on another person's account.
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return Response.redirect(new URL("/login", request.url));
  const userId = user.id;

  const expected = request.cookies.get(GMAIL_NONCE_COOKIE)?.value;
  if (error || !code || !nonce || !expected || nonce !== expected) {
    return failed();
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    console.error("Token exchange failed:", await tokenRes.text());
    return failed();
  }

  const tokens = await tokenRes.json();
  const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const supabase = createServiceClient();

  // Upsert tokens
  const { error: tokenErr } = await supabase.from("gmail_tokens").upsert({
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expiry: expiry,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (tokenErr) {
    // Don't say "connected" when nothing was stored.
    console.error("[gmail/callback] gmail_tokens upsert failed:", tokenErr.message);
    return failed();
  }

  // Mark gmail_connected on profile
  const { data: profile } = await supabase
    .from("profiles")
    .update({ gmail_connected: true })
    .eq("id", userId)
    .select("onboarded")
    .single();

  // Route by onboarded status only: fully-onboarded users go to settings,
  // mid-onboarding users return to /onboarding to finish. The onboarding
  // page now saves form state before the OAuth redirect, so rehydration
  // via loadProfile() brings them back to the exact state they left in.
  const redirectPath = profile?.onboarded
    ? "/settings?gmail=connected"
    : origin === "onboarding"
    ? "/onboarding?gmail=connected"
    : "/settings?gmail=connected";

  const res = NextResponse.redirect(new URL(redirectPath, request.url));
  res.cookies.delete({ name: GMAIL_NONCE_COOKIE, path: "/api/gmail" });
  return res;
}
