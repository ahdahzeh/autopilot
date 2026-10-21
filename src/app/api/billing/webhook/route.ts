import { createServiceClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/sentry";
import {
  applyCreditGrant,
  constructWebhookEvent,
  getStripe,
  grantFromEvent,
} from "@/lib/billing-server";

export const dynamic = "force-dynamic";

// POST /api/billing/webhook: Stripe calls this after a Checkout payment.
//
// The signature is verified over the raw body (never a parsed one) with
// STRIPE_WEBHOOK_SECRET, then checkout.session.completed with payment_status
// 'paid' adds the pack's credits exactly once: add_tailor_credits is keyed
// on the checkout session id, so Stripe's retries and the billing page's
// own grant attempt land on the same row and credit nothing twice.
//
// Note for the proxy: this path receives no cookies, so it must be listed in
// publicPaths in src/proxy.ts or Stripe gets redirected to /login.
export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!stripe || !secret) {
    return Response.json({ error: "Payments are not set up yet" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await req.text();
  let event;
  try {
    event = constructWebhookEvent(stripe, rawBody, signature, secret);
  } catch (err) {
    captureError(err, { route: "billing/webhook", stage: "verify" });
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  const grant = grantFromEvent(event);
  if (!grant) {
    // Not a paid checkout event, or not one of ours. Acknowledge so Stripe
    // stops retrying; there is nothing to do with it.
    return Response.json({ received: true, credited: false });
  }

  try {
    const credited = await applyCreditGrant(createServiceClient(), grant);
    return Response.json({ received: true, credited });
  } catch (err) {
    // 5xx makes Stripe retry, which is what we want when the database is
    // the thing that failed.
    captureError(err, { route: "billing/webhook", stage: "grant", sessionId: grant.sessionId });
    return Response.json({ error: "Unable to record the purchase" }, { status: 500 });
  }
}
