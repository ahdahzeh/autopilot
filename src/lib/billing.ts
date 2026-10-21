// Billing configuration shared by the tailor route, the billing API routes,
// the billing page and scripts/tailor-cost. Nothing in here talks to Stripe
// or the database (that is src/lib/billing-server.ts), so client components
// can import it without dragging server code into the bundle.

// Free tailors per user per UTC day on the owner's shared Anthropic key.
// Was 40 until 2026-10-20. Dropped to 20 when the Per Scholas NY cohort
// (about 30 people) joined, with paid credits for anyone who needs more.
// Users who add their own Anthropic key in Settings are never capped.
export const TAILOR_DAILY_LIMIT = 20;

// Anthropic list prices in USD per million tokens. Source: the claude-api
// skill's model table (platform.claude.com/docs/en/about-claude/pricing), read
// on 2026-10-20: Sonnet 4.6 is $3 in / $15 out, Haiku 4.5 is $1 / $5. Cache
// reads bill at 0.1x the input price and cache writes at 1.25x (5 minute TTL)
// per the same skill's prompt-caching reference. Both id forms are listed
// because the route sends the dashed id to the Anthropic API and the dotted
// id to the Vercel AI Gateway (see MODELS in src/lib/tailor-prompts.ts).
// Update here when Anthropic changes prices; tailor_events stores tokens, not
// dollars, for exactly that reason.
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const SONNET_4_6: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const HAIKU_4_5: ModelPrice = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

export const MODEL_PRICES_PER_MTOK: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": SONNET_4_6,
  "anthropic/claude-sonnet-4.6": SONNET_4_6,
  "claude-haiku-4-5-20251001": HAIKU_4_5,
  "anthropic/claude-haiku-4.5": HAIKU_4_5,
};

// One model call (or the sum of several) split into the buckets Anthropic
// bills at different rates. inputTokens is the UNCACHED prompt count only;
// cache reads and writes live in their own fields. See tokenUsageOf.
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

// What generateText/generateObject put in `usage` (ai@6 LanguageModelUsage),
// typed structurally so this file never imports the ai package and client
// components can still load it. Every field may be undefined for a provider
// that does not report it.
export type SdkUsage = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

// Splits one call's usage into billable buckets. Checked against ai@6.0.149
// with @ai-sdk/anthropic 3.0.67 on 2026-10-20: `usage.inputTokens` is the
// TOTAL prompt size, which the Anthropic provider builds as input_tokens +
// cache_creation_input_tokens + cache_read_input_tokens
// (convert-anthropic-messages-usage.ts), and the uncached part is
// inputTokenDetails.noCacheTokens. Storing that total as inputTokens and
// then pricing the cache buckets on top would charge every cached token
// twice ($3.30 instead of $0.30 per MTok for a cache read on Sonnet 4.6), so
// inputTokens here is the uncached count. A provider that reports no
// breakdown falls back to total minus the cache buckets, which is the same
// number when both are zero.
export function tokenUsageOf(usage: SdkUsage | undefined): TokenUsage {
  const total = usage?.inputTokens ?? 0;
  const cacheReadTokens = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  const inputTokens =
    usage?.inputTokenDetails?.noCacheTokens ??
    Math.max(0, total - cacheReadTokens - cacheWriteTokens);
  return {
    inputTokens,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function sumTokenUsage(calls: TokenUsage[]): TokenUsage {
  return calls.reduce<TokenUsage>(
    (acc, c) => ({
      inputTokens: acc.inputTokens + c.inputTokens,
      outputTokens: acc.outputTokens + c.outputTokens,
      cacheReadTokens: (acc.cacheReadTokens ?? 0) + (c.cacheReadTokens ?? 0),
      cacheWriteTokens: (acc.cacheWriteTokens ?? 0) + (c.cacheWriteTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

// Dollar cost of one usage record, or null for a model we have no price for.
// Each bucket is priced on its own; inputTokens must already exclude cached
// tokens (tokenUsageOf guarantees that).
export function usageCostUsd(model: string, usage: TokenUsage): number | null {
  const price = MODEL_PRICES_PER_MTOK[model];
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadTokens ?? 0) * price.cacheRead +
      (usage.cacheWriteTokens ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

// ---- Credit pack ---------------------------------------------------------

// Stripe's standard US card fee. Used to price the pack and to show the
// owner what a sale nets.
export const STRIPE_FEE_PERCENT = 0.029;
export const STRIPE_FEE_FIXED_CENTS = 30;

// Every pack key starts with this. The webhook only grants for sessions whose
// metadata.pack carries it, so a Stripe account shared with another product
// cannot have that product's checkouts credited here.
export const CREDIT_PACK_KEY_PREFIX = "tailor_";

export type CreditPack = {
  // Stable key stored on the Stripe session metadata and the purchase ledger.
  key: string;
  credits: number;
  priceCents: number;
  currency: "usd";
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Defaults: 20 credits for $5, so one extra tailor costs $0.25.
//
// Measured on 2026-10-20 with scripts/tailor-cost (one run, Sonnet 4.6,
// professional tone) on an entry-level IT resume (2,696 chars) and a full
// hospital help desk posting (2,658 chars). The 9-block run the route
// performs per "Tailor for this job" click used 22,496 input + 6,694 output
// tokens: $0.1679 per tailor, every block clean on the first call. The 5
// blocks the modal actually shows were $0.1159 of that.
//
// Pricing follows the brief (measured cost, plus Stripe's 2.9% + $0.30, about
// a 30% margin, a friendly round number):
//   20 tailors x $0.1679          = $3.36 Anthropic cost per pack
//   x 1.30                        = $4.37 to keep after Stripe
//   (4.37 + 0.30) / (1 - 0.029)   = $4.80 sticker price
//   rounded to a whole dollar     = $5.00, which nets $4.555 after the $0.445
//                                   fee: 36% over the measured cost
// Headroom: that run needed no correction retry, so it is a floor. A retry of
// the most expensive block (prep, $0.04) makes a tailor $0.21, and a resume at
// the 8,000 char prompt cap adds about $0.035 more. At that $0.24 a pack costs
// $4.85 and $5 loses about $0.30 on it. TAILOR_CREDIT_PACK_PRICE_CENTS=600
// nets $5.53 instead: 65% over the measured cost, 14% in that worst case.
// Revisit once tailor_events holds a few weeks of real token counts. Override
// the pack per environment with TAILOR_CREDIT_PACK_CREDITS and
// TAILOR_CREDIT_PACK_PRICE_CENTS.
export const DEFAULT_PACK_CREDITS = 20;
export const DEFAULT_PACK_PRICE_CENTS = 500;

export function getCreditPack(): CreditPack {
  const credits = intFromEnv("TAILOR_CREDIT_PACK_CREDITS", DEFAULT_PACK_CREDITS);
  const priceCents = intFromEnv("TAILOR_CREDIT_PACK_PRICE_CENTS", DEFAULT_PACK_PRICE_CENTS);
  return { key: `${CREDIT_PACK_KEY_PREFIX}${credits}`, credits, priceCents, currency: "usd" };
}

// What a sale of this pack leaves after Stripe, in cents.
export function netAfterStripeCents(priceCents: number): number {
  return Math.round(priceCents * (1 - STRIPE_FEE_PERCENT) - STRIPE_FEE_FIXED_CENTS);
}

export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

// ---- Shared state shape --------------------------------------------------

// What the tailor route, GET /api/billing/status and the billing page all
// agree a user's situation looks like.
export type BillingState = {
  usedToday: number;
  dailyLimit: number;
  credits: number;
  // Own Anthropic key on file: no cap, no credits needed.
  hasOwnKey: boolean;
  // STRIPE_SECRET_KEY is configured, so the buy button can show.
  paymentsEnabled: boolean;
};

export type PaidWith = "cap" | "credit" | "own_key";

export const BILLING_PATH = "/settings/billing";
