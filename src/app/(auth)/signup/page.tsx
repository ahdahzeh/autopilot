"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { getTrackPreset } from "@/lib/track-presets";

// What check_invite_code() said about the code in the field. "unavailable"
// means the call itself failed, most likely because migration 020 is not
// applied yet (PostgREST answers PGRST202 for a function it does not know).
// Signup must not stall on that, so the code is simply tried again at redeem
// time and the member goes through the full onboarding if that fails too.
type CodeCheck =
  | { status: "idle" | "checking" | "unavailable" | "invalid" }
  | { status: "valid"; label: string | null };

// Codes are stored upper-case; the RPCs upper-case and trim too, this just
// keeps what the user sees in step with what is sent.
function normalizeCode(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showInviteField, setShowInviteField] = useState(false);
  const [codeFromLink, setCodeFromLink] = useState(false);
  const [codeCheck, setCodeCheck] = useState<CodeCheck>({ status: "idle" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  // Cohort members arrive through /signup?code=PSNY-CYBER. Read the query
  // string once on mount, the same way onboarding reads ?gmail=connected, so
  // the field is shown and filled without a useSearchParams Suspense boundary.
  useEffect(() => {
    const code = normalizeCode(new URLSearchParams(window.location.search).get("code"));
    if (code) {
      setInviteCode(code);
      setShowInviteField(true);
      setCodeFromLink(true);
    }
  }, []);

  async function checkInviteCode(code: string): Promise<CodeCheck> {
    const { data, error: rpcError } = await supabase.rpc("check_invite_code", { code });
    if (rpcError) return { status: "unavailable" };
    const result = data as { valid?: boolean; label?: string | null } | null;
    return result?.valid ? { status: "valid", label: result.label ?? null } : { status: "invalid" };
  }

  // Validate while the code is typed (debounced) so a typo or a used-up code
  // is caught before an account exists. Submit checks again regardless.
  useEffect(() => {
    const code = normalizeCode(inviteCode);
    if (!code) {
      setCodeCheck({ status: "idle" });
      return;
    }
    let cancelled = false;
    setCodeCheck({ status: "checking" });
    const timer = setTimeout(async () => {
      const result = await checkInviteCode(code);
      if (!cancelled) setCodeCheck(result);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checkInviteCode only closes over the singleton client
  }, [inviteCode]);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const code = normalizeCode(inviteCode);

    // A code that is known to be bad stops signup here, while the field can
    // still be cleared. An unreachable check is not a reason to block.
    if (code) {
      const result = await checkInviteCode(code);
      setCodeCheck(result);
      if (result.status === "invalid") {
        setError("This invite code is not valid. Fix it, or clear the field to sign up without one.");
        setLoading(false);
        return;
      }
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: name },
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    // Add to Resend audience. Non-blocking: signup never fails on a subscribe error.
    fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name }),
    }).catch(() => {});

    // Claim the invite server side. redeem_invite_code() checks capacity and
    // expiry under a row lock, counts this user once, and copies the code's
    // prefilled profile onto the new profile row. The account exists by now,
    // so a refusal (the last seat went to someone else between the check and
    // the claim, or the RPC is not deployed yet) sends the member through the
    // full onboarding instead of failing signup.
    if (code && data.user) {
      const { data: redeemed, error: redeemError } = await supabase.rpc("redeem_invite_code", { code });
      const result = redeemed as { ok?: boolean; reason?: string } | null;
      if (redeemError || !result?.ok) {
        console.warn("[signup] invite code not redeemed:", redeemError?.message ?? result?.reason ?? "unknown");
      }
    }

    router.push("/onboarding");
    router.refresh();
  }

  const normalizedCode = normalizeCode(inviteCode);
  // The track name shown next to the code. The server's answer wins; while it
  // is pending or unreachable, the three Per Scholas codes are also known
  // locally (src/lib/track-presets.ts), so a cohort link still names its
  // track instead of showing a bare code.
  const localLabel = getTrackPreset(normalizedCode)?.label ?? null;
  const inviteLabel = codeCheck.status === "valid" ? codeCheck.label ?? localLabel : localLabel;

  function continueWithoutCode() {
    setInviteCode("");
    setCodeFromLink(false);
    setError("");
  }

  return (
    <form onSubmit={handleSignup} className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        {codeFromLink && normalizedCode && codeCheck.status !== "idle" && codeCheck.status !== "invalid" && (
          <div
            className={`rounded-lg border px-3 py-2.5 ${
              codeCheck.status === "valid" ? "border-accent-green/30 bg-accent-green/5" : "border-border bg-white"
            }`}
          >
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium">Invite</p>
            <p className="text-sm font-semibold mt-0.5">{inviteLabel ?? normalizedCode}</p>
            <p className="text-[10px] text-muted mt-1">
              {codeCheck.status === "checking" && "Checking the code"}
              {codeCheck.status === "valid" && "Valid code. Create your account to claim your seat."}
              {codeCheck.status === "unavailable" &&
                "Unable to check the code right now. It will be tried again when you create your account."}
            </p>
          </div>
        )}
        {codeFromLink && codeCheck.status === "invalid" && (
          <div className="rounded-lg border border-accent-red/30 bg-accent-red/5 px-3 py-2.5 space-y-1.5">
            <p className="text-sm font-semibold">This invite link is no longer valid</p>
            <p className="text-[10px] text-muted">
              It may have expired or run out of seats. You can still create an account and set your preferences during setup, or ask whoever sent the link for a new one.
            </p>
            <button
              type="button"
              onClick={continueWithoutCode}
              className="text-[10px] font-medium text-accent-red hover:underline"
            >
              Continue without a code
            </button>
          </div>
        )}
        <div>
          <label className="text-[10px] uppercase tracking-widest text-muted font-medium block mb-1.5">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-widest text-muted font-medium block mb-1.5">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-widest text-muted font-medium block mb-1.5">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
          />
        </div>
        {showInviteField ? (
          <div>
            <label htmlFor="invite-code" className="text-[10px] uppercase tracking-widest text-muted font-medium block mb-1.5">
              Invite code
            </label>
            <input
              id="invite-code"
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="e.g. ABC123"
              autoFocus={!codeFromLink}
              aria-describedby="invite-code-status"
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 mono uppercase"
            />
            <p id="invite-code-status" className="text-[10px] mt-1.5 min-h-[1em]">
              {codeCheck.status === "checking" && <span className="text-muted">Checking code</span>}
              {codeCheck.status === "valid" && (
                <span className="text-accent-green">
                  Valid code{inviteLabel ? `: ${inviteLabel}` : ""}
                </span>
              )}
              {codeCheck.status === "invalid" && (
                <span className="text-accent-red">
                  This code is not valid. Check it for typos, or clear the field to sign up without one.
                </span>
              )}
              {codeCheck.status === "unavailable" && (
                <span className="text-muted">
                  Unable to check the code right now. It will be tried again when you create your account.
                </span>
              )}
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowInviteField(true)}
            className="text-[10px] text-muted hover:text-foreground transition self-start"
          >
            Have an invite code?
          </button>
        )}
        {error && <p className="text-xs text-accent-red">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 text-sm font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? "Creating account..." : "Create Account"}
        </button>
      </div>
      <p className="text-center text-xs text-muted">
        Already have an account?{" "}
        <a href="/login" className="text-accent-purple hover:underline">Sign in</a>
      </p>
    </form>
  );
}
