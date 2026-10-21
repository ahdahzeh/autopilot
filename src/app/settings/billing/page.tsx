import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/sentry";
import { getCreditPack } from "@/lib/billing";
import {
  creditCheckoutSession,
  getStripe,
  loadBillingState,
} from "@/lib/billing-server";
import { BillingView, type CheckoutNotice, type Purchase } from "@/components/billing-view";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// /settings/billing: today's usage against the daily cap, the credit
// balance, the buy button, and the purchase history. Loads everything
// server side with the user's own session (RLS scopes every table to them).
export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const pack = getCreditPack();
  const notice = await resolveCheckoutNotice(params, user.id);

  const [state, purchasesRes] = await Promise.all([
    loadBillingState(supabase, user.id),
    supabase
      .from("tailor_credit_purchases")
      .select("id, created_at, pack, credits, amount_cents, currency")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  // A missing table (migration 021 not applied yet) reads as no purchases.
  if (purchasesRes.error) {
    captureError(purchasesRes.error, { route: "settings/billing", stage: "load_purchases" });
  }
  const purchases = (purchasesRes.data ?? []) as Purchase[];

  return (
    <BillingView
      state={state}
      pack={{ credits: pack.credits, priceCents: pack.priceCents }}
      purchases={purchases}
      notice={notice}
    />
  );
}

// Coming back from Stripe Checkout. On success we grant right away through
// the same idempotent RPC the webhook uses, so the balance is right even
// when the webhook is slow or not configured yet. Never throws: a Stripe
// hiccup here must not take the page down, it just shows "processing".
async function resolveCheckoutNotice(
  params: { [key: string]: string | string[] | undefined },
  userId: string,
): Promise<CheckoutNotice | null> {
  const checkout = typeof params.checkout === "string" ? params.checkout : "";
  if (checkout === "cancelled") return { kind: "cancelled" };
  if (checkout !== "success") return null;

  const sessionId = typeof params.session_id === "string" ? params.session_id : "";
  const stripe = getStripe();
  if (!sessionId || !stripe) return { kind: "pending" };

  try {
    const result = await creditCheckoutSession(stripe, createServiceClient(), sessionId, userId);
    if (result.outcome === "credited") return { kind: "credited", credits: result.credits };
    if (result.outcome === "already_credited") return { kind: "already_credited" };
    if (result.outcome === "unpaid") return { kind: "pending" };
    return null;
  } catch (err) {
    captureError(err, { route: "settings/billing", stage: "credit_checkout_session", sessionId });
    return { kind: "pending" };
  }
}
