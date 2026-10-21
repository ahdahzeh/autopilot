"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatUsd, type BillingState } from "@/lib/billing";

export type Purchase = {
  id: string;
  created_at: string;
  pack: string;
  credits: number;
  amount_cents: number;
  currency: string;
};

export type CheckoutNotice =
  | { kind: "credited"; credits: number }
  | { kind: "already_credited" }
  | { kind: "pending" }
  | { kind: "cancelled" };

type Props = {
  state: BillingState;
  pack: { credits: number; priceCents: number };
  purchases: Purchase[];
  notice: CheckoutNotice | null;
};

export function BillingView({ state, pack, purchases, notice }: Props) {
  const router = useRouter();
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState("");

  const remaining = Math.max(0, state.dailyLimit - state.usedToday);
  const pct = Math.min(100, Math.round((state.usedToday / state.dailyLimit) * 100));
  const usageTone =
    state.hasOwnKey ? "ok" :
    remaining === 0 ? "danger" :
    remaining <= 5 ? "warn" : "ok";

  async function buyCredits() {
    setBuying(true);
    setBuyError("");
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setBuyError(data.error || "Unable to start checkout. Try again.");
        return;
      }
      window.location.assign(data.url);
    } catch {
      setBuyError("Unable to start checkout. Check your connection and try again.");
    } finally {
      setBuying(false);
    }
  }

  return (
    <div className="min-h-screen px-4 md:px-8 lg:px-12 py-4 md:py-6" style={{ background: "var(--background)" }}>
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="cb-brand">
            <div className="hdr-mark">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="4" />
                <line x1="12" y1="3" x2="12" y2="8" />
                <line x1="12" y1="16" x2="12" y2="21" />
              </svg>
            </div>
            <div>
              <div className="cb-brand__name">Autopilot</div>
              <div className="cb-brand__sub">Billing</div>
            </div>
          </div>
          <button onClick={() => router.push("/settings")} className="cb-btn">
            ← Settings
          </button>
        </div>

        {notice && <Notice notice={notice} />}

        {/* Today */}
        <Section title="Today's tailoring">
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold">Free tailors used today</p>
              <p className="mono text-sm font-bold tabular-nums">
                {state.hasOwnKey ? "No cap" : `${state.usedToday} / ${state.dailyLimit}`}
              </p>
            </div>
            <div className="h-1.5 w-full bg-border/50 rounded-full overflow-hidden">
              <div
                className="h-full transition-all"
                style={{
                  width: `${state.hasOwnKey ? 0 : pct}%`,
                  background:
                    usageTone === "danger" ? "var(--accent-red)" :
                    usageTone === "warn" ? "var(--accent)" :
                    "var(--accent-purple)",
                }}
              />
            </div>
            <p className="text-[10px] text-muted mt-2">
              {state.hasOwnKey
                ? "Your own Anthropic key is on file, so the daily cap does not apply and no credits are used."
                : remaining === 0
                  ? `All ${state.dailyLimit} free tailors are used. The count resets at midnight UTC. Credits below keep you going until then.`
                  : `${remaining} free ${remaining === 1 ? "tailor" : "tailors"} left today. The count resets at midnight UTC.`}
            </p>
          </div>
        </Section>

        {/* Credits */}
        <Section title="Credits">
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold">Credit balance</p>
                <p className="text-[10px] text-muted mt-0.5">
                  One credit is one tailor beyond the {state.dailyLimit} free per day. Credits do not expire.
                </p>
              </div>
              <span className="mono text-2xl font-bold tabular-nums">{state.credits}</span>
            </div>

            {state.paymentsEnabled ? (
              <div className="flex items-center gap-3 flex-wrap pt-1">
                <button onClick={buyCredits} disabled={buying} className="cb-btn cb-btn--solid">
                  {buying ? "Opening checkout..." : `Buy ${pack.credits} credits for ${formatUsd(pack.priceCents)}`}
                </button>
                <span className="text-[10px] text-muted">
                  Card payment through Stripe. Credits are added as soon as the payment clears.
                </span>
                {buyError && (
                  <span className="mono text-[10px] uppercase tracking-widest" style={{ color: "var(--danger)" }}>
                    {buyError}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-muted pt-1">
                Paid credits are not available yet. To tailor without a cap, add your own Anthropic API key in{" "}
                <a href="/settings" className="text-accent-purple hover:opacity-70">Settings</a>.
              </p>
            )}
          </div>
        </Section>

        {/* Purchase history */}
        <Section title="Purchase history">
          {purchases.length > 0 ? (
            <div className="space-y-2">
              {purchases.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 px-4 py-3 border border-border rounded-xl bg-card"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {p.credits} {p.credits === 1 ? "credit" : "credits"}
                    </p>
                    <p className="text-[9px] mono text-muted uppercase tracking-widest">
                      {formatDate(p.created_at)}
                    </p>
                  </div>
                  <span className="mono text-sm font-bold tabular-nums shrink-0">
                    {formatMoney(p.amount_cents, p.currency)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-3 border border-border rounded-xl bg-card">
              <p className="text-xs font-semibold">No purchases yet</p>
              <p className="text-[10px] text-muted mt-0.5">
                Credits you buy will be listed here with the date and amount.
              </p>
            </div>
          )}
        </Section>

        <p className="text-[10px] text-muted mb-10">
          Tone, model and your own Anthropic key live in{" "}
          <a href="/settings" className="text-accent-purple hover:opacity-70">Settings</a>.
        </p>
      </div>
    </div>
  );
}

function Notice({ notice }: { notice: CheckoutNotice }) {
  const text =
    notice.kind === "credited"
      ? `Payment received. ${notice.credits} credits were added to your balance.`
      : notice.kind === "already_credited"
        ? "Payment received. Your credits are already in your balance."
        : notice.kind === "pending"
          ? "Payment is still processing. Credits appear here once Stripe confirms it; refresh in a minute."
          : "Checkout cancelled. Nothing was charged.";
  const color =
    notice.kind === "cancelled" ? "var(--muted)" :
    notice.kind === "pending" ? "var(--accent)" :
    "var(--success)";
  return (
    <div className="flex items-center gap-3 px-4 py-3 border border-border rounded-xl bg-card mb-6">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      <p className="text-xs">{text}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-[10px] uppercase tracking-widest text-muted font-medium mb-3">{title}</h2>
      {children}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return formatUsd(cents);
  }
}
