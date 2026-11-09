import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Public along with anything under them. Matched as whole path segments (the
// path itself or the path and a slash), so a route like /api/cron-admin or
// /signup-admin is not public just because it shares a prefix.
const publicPaths = ["/login", "/signup", "/api/cron", "/api/subscribe"];

// Routes that receive no session cookie: Stripe's webhook and the unsubscribe
// link in every email (opened signed out, or POSTed by a mail client as an
// RFC 8058 one-click request). Matched exactly, with or without a trailing
// slash, so nothing next to them opens by prefix. /api/gmail/callback stays
// gated: it stores tokens on the signed-in account, and the browser carries
// the session cookie back from Google.
const exactPublicPaths = new Set(["/api/billing/webhook", "/api/emails/unsubscribe"]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Root path renders a marketing landing for anonymous users and the
  // dashboard for authed users; page.tsx handles the split server-side.
  if (pathname === "/") {
    return NextResponse.next();
  }

  // Allow public paths
  if (publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  if (exactPublicPaths.has(pathname.replace(/\/$/, ""))) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Check if user has completed onboarding
  if (!pathname.startsWith("/onboarding") && !pathname.startsWith("/api")) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("onboarded")
      .eq("id", user.id)
      .single();

    if (profile && !profile.onboarded) {
      const url = request.nextUrl.clone();
      url.pathname = "/onboarding";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
