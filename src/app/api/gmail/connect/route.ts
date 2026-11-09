import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { GMAIL_NONCE_COOKIE } from "@/lib/gmail-oauth";

export const dynamic = "force-dynamic";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.redirect(new URL("/login", request.url));

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/callback`;

  if (!clientId) {
    return Response.json({ error: "Google OAuth not configured" }, { status: 500 });
  }

  const origin = new URL(request.url).searchParams.get("origin") || "settings";
  // The callback takes the user from the session, never from state. The nonce
  // ties the code Google sends back to the browser that started here, so a
  // link built with someone else's code can't attach their mailbox to this
  // account.
  const nonce = randomBytes(24).toString("base64url");
  const state = JSON.stringify({ nonce, origin });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const res = NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );
  res.cookies.set(GMAIL_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax: Google sends the browser back with a top-level GET.
    sameSite: "lax",
    path: "/api/gmail",
    maxAge: 600,
  });
  return res;
}
