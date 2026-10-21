import { createClient } from "@/lib/supabase/server";
import { getCreditPack } from "@/lib/billing";
import { loadBillingState } from "@/lib/billing-server";

export const dynamic = "force-dynamic";

// GET /api/billing/status: today's usage, credit balance and whether the
// buy button should show. The job modal reads this to tell the user where
// they stand before they click Tailor.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const state = await loadBillingState(supabase, user.id);
  const pack = getCreditPack();
  return Response.json({
    ...state,
    pack: { credits: pack.credits, priceCents: pack.priceCents, currency: pack.currency },
  });
}
