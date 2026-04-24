import { createServiceClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const stateRaw = searchParams.get("state") || "{}";
  const error = searchParams.get("error");
  let userId = "";
  let origin = "settings";
  try {
    const state = JSON.parse(stateRaw);
    userId = state.userId || stateRaw; // backwards compat
    origin = state.origin || "settings";
  } catch {
    userId = stateRaw;
  }

  if (error || !code || !userId) {
    return Response.redirect(
      new URL("/settings?gmail=error", request.url)
    );
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
    return Response.redirect(new URL("/settings?gmail=error", request.url));
  }

  const tokens = await tokenRes.json();
  const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const supabase = createServiceClient();

  // Upsert tokens
  await supabase.from("gmail_tokens").upsert({
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expiry: expiry,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });

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

  return Response.redirect(new URL(redirectPath, request.url));
}
