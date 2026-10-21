// Server-side billing: the Stripe client, the shared billing-state loader,
// the cap-or-credit reservation the tailor route makes, and the pure pieces
// of the Stripe flow (checkout params, signature verification, turning a
// checkout session into a credit grant).
//
// Never import this from a client component: it pulls in the stripe SDK.
// It deliberately does not import next/headers either; callers pass in the
// Supabase client they already have, which is what lets
// scripts/billing/webhook-test.ts exercise the webhook logic under tsx with
// generated signatures and a fake database.

import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { captureError } from "@/lib/sentry";
import {
  BILLING_PATH,
  TAILOR_DAILY_LIMIT,
  getCreditPack,
  type BillingState,
  type CreditPack,
  type PaidWith,
} from "@/lib/billing";

// The project has no generated database types, so every client is the
// untyped SupabaseClient that createClient()/createServiceClient() return.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = SupabaseClient<any, any, any>;

// ---- Stripe client -------------------------------------------------------

export function paymentsEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

let stripeClient: Stripe | null = null;

// Null when STRIPE_SECRET_KEY is not set, so every caller degrades to
// "Payments are not set up yet" instead of throwing at import time.
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(key, { appInfo: { name: "autopilot" } });
  }
  return stripeClient;
}

// ---- Billing state -------------------------------------------------------

// Same UTC day the settings page and record_tailor_use() use.
export function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadBillingState(
  supabase: Client,
  userId: string,
  known: { hasOwnKey?: boolean } = {},
): Promise<BillingState> {
  const [usage, credits, profile] = await Promise.all([
    supabase
      .from("tailor_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("day", utcDay())
      .maybeSingle(),
    supabase
      .from("tailor_credits")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle(),
    known.hasOwnKey === undefined
      ? supabase.from("profiles").select("anthropic_api_key").eq("id", userId).maybeSingle()
      : Promise.resolve(null),
  ]);

  // A missing table (migration 021 not applied yet) must not take the page
  // down; it just reads as zero credits.
  if (credits?.error) captureError(credits.error, { route: "billing", stage: "load_credits" });
  if (usage?.error) captureError(usage.error, { route: "billing", stage: "load_usage" });

  const hasOwnKey =
    known.hasOwnKey ??
    Boolean((profile?.data?.anthropic_api_key as string | null | undefined)?.trim());

  return {
    usedToday: (usage?.data?.count as number | undefined) ?? 0,
    dailyLimit: TAILOR_DAILY_LIMIT,
    credits: (credits?.data?.balance as number | undefined) ?? 0,
    hasOwnKey,
    paymentsEnabled: paymentsEnabled(),
  };
}

// ---- Reservation (tailor route) -------------------------------------------

export type Reservation =
  | { paidWith: "cap"; usedToday: number }
  | { paidWith: "credit"; creditsLeft: number };

// Decide how one tailor request is allowed through, in this order: under the
// daily cap it counts against the free allowance; at or over the cap it
// spends a purchased credit; with neither it is refused and the caller
// returns 429. Both RPCs are single-statement SECURITY DEFINER functions
// (migration 021), so two requests racing for the last slot or the last
// credit cannot both win.
//
// allowCredit=false stops at the cap without spending. The job modal's
// automatic cover draft uses it: a paid credit should only go where the
// user clicked Tailor, never on something that fired because a modal opened.
export async function reserveTailor(
  supabase: Client,
  userId: string,
  opts: { allowCredit?: boolean } = {},
): Promise<Reservation | null> {
  const used = await supabase.rpc("record_tailor_use", { p_limit: TAILOR_DAILY_LIMIT });
  if (used.error) {
    // Most likely the migration has not been applied yet. Keep the product
    // working the way it did before credits existed: read-then-bump.
    captureError(used.error, { route: "tailor", stage: "record_tailor_use", note: "falling back to legacy counter" });
    const legacy = await legacyRecordTailorUse(supabase, userId);
    return legacy === null ? null : { paidWith: "cap", usedToday: legacy };
  }
  if (typeof used.data === "number") {
    return { paidWith: "cap", usedToday: used.data };
  }
  if (opts.allowCredit === false) return null;

  const credit = await supabase.rpc("consume_tailor_credit");
  if (credit.error) {
    captureError(credit.error, { route: "tailor", stage: "consume_tailor_credit" });
    return null;
  }
  if (typeof credit.data === "number") {
    return { paidWith: "credit", creditsLeft: credit.data };
  }
  return null;
}

// ---- Cap reached ---------------------------------------------------------

// The 429 body the tailor route returns when neither the free allowance nor a
// credit let the request through. One shape, three messages, because the fix
// differs: a user whose automatic cover draft was refused while holding
// credits only needs to click Tailor; a user with none either buys a pack or,
// when Stripe is not configured, waits or adds their own key. The path is in
// the text as well as in billingUrl so a client without the modal's link
// still learns where to go.
export function capReachedBody(state: BillingState, opts: { creditWithheld: boolean }) {
  const lead = `Daily limit reached: ${state.dailyLimit} free tailors per day.`;
  let error: string;
  if (opts.creditWithheld) {
    const n = state.credits;
    error = `${lead} You have ${n} ${n === 1 ? "credit" : "credits"}. Click "Tailor for this job" to spend one.`;
  } else if (state.paymentsEnabled) {
    error = `${lead} Buy credits at ${BILLING_PATH} to keep going, or wait until midnight UTC.`;
  } else {
    error = `${lead} The count resets at midnight UTC. Your usage is at ${BILLING_PATH}; adding your own Anthropic API key in Settings removes the cap.`;
  }
  return {
    error,
    code: "cap_reached" as const,
    billingUrl: BILLING_PATH,
    usedToday: state.usedToday,
    dailyLimit: state.dailyLimit,
    credits: state.credits,
    paymentsEnabled: state.paymentsEnabled,
  };
}

// The pre-021 counter: not atomic, kept only as the fallback above. Once 021
// is applied the direct write policies on tailor_usage are gone too, so this
// path's upsert is refused and the request goes through uncounted, the same
// fail-open choice the old route made when its counter broke.
async function legacyRecordTailorUse(supabase: Client, userId: string): Promise<number | null> {
  const day = utcDay();
  try {
    const { data: row } = await supabase
      .from("tailor_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("day", day)
      .maybeSingle();
    const current = (row?.count as number | undefined) ?? 0;
    if (current >= TAILOR_DAILY_LIMIT) return null;
    await supabase
      .from("tailor_usage")
      .upsert({ user_id: userId, day, count: current + 1 }, { onConflict: "user_id,day" });
    return current + 1;
  } catch (e) {
    captureError(e, { route: "tailor", stage: "rate_limit" });
    // Same choice the old route made: a broken counter does not block users.
    return 0;
  }
}

// Service role only. Used when a credit was spent and every block failed
// before the model answered, so the user is not charged for nothing.
export async function refundTailorCredit(service: Client, userId: string): Promise<void> {
  const { error } = await service.rpc("refund_tailor_credit", { p_user_id: userId });
  if (error) captureError(error, { route: "tailor", stage: "refund_tailor_credit", userId });
}

export type TailorEvent = {
  user_id: string;
  request_id: string;
  job_id: string | null;
  block: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  paid_with: PaidWith;
  ok: boolean;
};

// Fire-and-forget usage log. Written with the service role so the log
// cannot be padded from a browser session. Never throws.
export async function recordTailorEvent(service: Client, event: TailorEvent): Promise<void> {
  try {
    const { error } = await service.from("tailor_events").insert(event);
    if (error) captureError(error, { route: "tailor", stage: "record_tailor_event", block: event.block });
  } catch (e) {
    captureError(e, { route: "tailor", stage: "record_tailor_event", block: event.block });
  }
}

// ---- Checkout ------------------------------------------------------------

export function checkoutSessionParams(args: {
  pack: CreditPack;
  userId: string;
  email: string | undefined;
  origin: string;
}): Stripe.Checkout.SessionCreateParams {
  const { pack, userId, email, origin } = args;
  return {
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: pack.currency,
          unit_amount: pack.priceCents,
          product_data: {
            name: `Autopilot tailoring credits (${pack.credits})`,
            description: `${pack.credits} extra tailors beyond the ${TAILOR_DAILY_LIMIT} free ones per day. Credits do not expire.`,
          },
        },
      },
    ],
    // The webhook trusts these three fields to know who to credit and how
    // much. They are set here, server side, never from the browser.
    metadata: { user_id: userId, pack: pack.key, credits: String(pack.credits) },
    client_reference_id: userId,
    customer_email: email,
    success_url: `${origin}${BILLING_PATH}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${BILLING_PATH}?checkout=cancelled`,
  };
}

// ---- Webhook -------------------------------------------------------------

export type CreditGrant = {
  userId: string;
  sessionId: string;
  paymentIntentId: string | null;
  pack: string;
  credits: number;
  amountCents: number;
  currency: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verifies the Stripe signature over the raw request body. Throws
// Stripe.errors.StripeSignatureVerificationError on a bad or stale
// signature, which the route turns into a 400.
export function constructWebhookEvent(
  stripe: Stripe,
  rawBody: string,
  signature: string,
  secret: string,
): Stripe.Event {
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

// The event types that mean "the customer has paid". Card payments complete
// synchronously, so checkout.session.completed already carries
// payment_status 'paid'; delayed methods complete later through
// async_payment_succeeded. Both are handled the same way.
const PAID_EVENTS = new Set<string>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export function isPaidCheckoutEvent(event: Stripe.Event): boolean {
  return PAID_EVENTS.has(event.type);
}

// Null when the session is not paid or its metadata is not ours. Everything
// the grant needs comes from the session object, never from the request
// body as a whole, so a forged body that somehow passed verification would
// still have to carry a valid user id.
export function grantFromCheckoutSession(session: Stripe.Checkout.Session): CreditGrant | null {
  if (session.payment_status !== "paid") return null;
  const meta = session.metadata ?? {};
  const userId = meta.user_id ?? session.client_reference_id ?? "";
  const credits = Number.parseInt(meta.credits ?? "", 10);
  if (!UUID_RE.test(userId)) return null;
  if (!Number.isInteger(credits) || credits <= 0) return null;
  const pi = session.payment_intent;
  return {
    userId,
    sessionId: session.id,
    paymentIntentId: typeof pi === "string" ? pi : pi?.id ?? null,
    pack: meta.pack || `tailor_${credits}`,
    credits,
    amountCents: session.amount_total ?? 0,
    currency: session.currency ?? "usd",
  };
}

export function grantFromEvent(event: Stripe.Event): CreditGrant | null {
  if (!isPaidCheckoutEvent(event)) return null;
  return grantFromCheckoutSession(event.data.object as Stripe.Checkout.Session);
}

// Adds the credits exactly once per checkout session (add_tailor_credits
// is keyed on the session id). Returns true when credits were added, false
// when this session had already been recorded. Throws on a database error
// so the webhook answers 5xx and Stripe retries.
export async function applyCreditGrant(service: Client, grant: CreditGrant): Promise<boolean> {
  const { data, error } = await service.rpc("add_tailor_credits", {
    p_user_id: grant.userId,
    p_session_id: grant.sessionId,
    p_payment_intent_id: grant.paymentIntentId,
    p_pack: grant.pack,
    p_credits: grant.credits,
    p_amount_cents: grant.amountCents,
    p_currency: grant.currency,
  });
  if (error) throw new Error(`add_tailor_credits failed: ${error.message}`);
  return data === true;
}

export type CheckoutOutcome = "credited" | "already_credited" | "unpaid" | "not_yours";

// Used by the billing page when the user lands back on it after paying, so
// credits show up immediately even if the webhook is late or not configured
// yet. Idempotent through the same RPC the webhook uses.
export async function creditCheckoutSession(
  stripe: Stripe,
  service: Client,
  sessionId: string,
  expectedUserId: string,
): Promise<CheckoutOutcome> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const grant = grantFromCheckoutSession(session);
  if (!grant) return "unpaid";
  if (grant.userId !== expectedUserId) return "not_yours";
  return (await applyCreditGrant(service, grant)) ? "credited" : "already_credited";
}

export { getCreditPack };
