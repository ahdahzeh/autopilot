import { createClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/sentry";
import { getCreditPack } from "@/lib/billing";
import { checkoutSessionParams, getStripe } from "@/lib/billing-server";

export const dynamic = "force-dynamic";

// POST /api/billing/checkout: start a Stripe Checkout session for one credit
// pack and hand back its URL. The pack and price come from src/lib/billing.ts
// (env-overridable); nothing about the price is accepted from the browser.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const stripe = getStripe();
  if (!stripe) {
    return Response.json({ error: "Payments are not set up yet" }, { status: 503 });
  }

  try {
    const session = await stripe.checkout.sessions.create(
      checkoutSessionParams({
        pack: getCreditPack(),
        userId: user.id,
        email: user.email ?? undefined,
        origin: appOrigin(req),
      }),
    );
    if (!session.url) {
      return Response.json({ error: "Stripe did not return a checkout URL." }, { status: 502 });
    }
    return Response.json({ url: session.url });
  } catch (err) {
    captureError(err, { route: "billing/checkout", userId: user.id });
    return Response.json({ error: "Unable to start checkout. Try again." }, { status: 502 });
  }
}

// Where Stripe should send the user back. NEXT_PUBLIC_APP_URL is the
// canonical host in production; the request origin covers previews and
// local dev, where the env var would point somewhere else.
function appOrigin(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  const requestOrigin = req.headers.get("origin") || new URL(req.url).origin;
  if (!configured) return requestOrigin;
  if (requestOrigin.includes("localhost") || requestOrigin.includes("127.0.0.1")) return requestOrigin;
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") return requestOrigin;
  return configured;
}
