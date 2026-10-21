"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
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

// check_invite_code() is the only thing an anon client may learn about a
// code: whether it can still be redeemed and the label its creator gave it.
// Never the prefilled profile or who else used it (migration 020).
async function checkInviteCode(supabase: SupabaseClient, code: string): Promise<CodeCheck> {
  const { data, error } = await supabase.rpc("check_invite_code", { code });
  if (error) return { status: "unavailable" };
  const result = data as { valid?: boolean; label?: string | null } | null;
  return result?.valid ? { status: "valid", label: result.label ?? null } : { status: "invalid" };
}

// /signup is prerendered, and useSearchParams() inside a prerendered route
// renders the tree up to the nearest Suspense boundary on the client instead.
// The form sits under one so the shell around it still ships as static HTML.
export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="mono text-sm text-muted animate-pulse">Loading...</div>
        </div>
      }
    >
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const searchParams = useSearchParams();
  // Cohort members arrive through /signup?code=PSNY-CYBER. The code seeds the
  // form on its first render (the form only ever renders on the client, see
  // SignupPage), so nothing has to be patched in after mount.
  const initialCode = normalizeCode(searchParams.get("code"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState(initialCode);
  const [showInviteField, setShowInviteField] = useState(initialCode.length > 0);
  // True while the code in the field is the one the signup link carried and
  // the person has not edited it. It changes the wording of a refusal (an
  // expired link, rather than a typo) and shows the invite card up top.
  const [codeFromLink, setCodeFromLink] = useState(initialCode.length > 0);
  const [codeCheck, setCodeCheck] = useState<CodeCheck>(
    initialCode ? { status: "checking" } : { status: "idle" },
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const supabase = createClient();

  // Validate while the code is typed (debounced) so a typo or a used-up code
  // is caught before an account exists. Submit checks again regardless. The
  // "checking" status is set where the code changes (first render, the
  // change handler), so this effect only talks to the server.
  useEffect(() => {
    const code = normalizeCode(inviteCode);
    if (!code) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await checkInviteCode(supabase, code);
      if (!cancelled) setCodeCheck(result);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inviteCode, supabase]);

  function handleInviteCodeChange(raw: string) {
    setInviteCode(raw);
    // Once edited it is the person's code, not the link's: the card up top
    // goes away and a refusal reads as a typo.
    setCodeFromLink(false);
    setCodeCheck(normalizeCode(raw) ? { status: "checking" } : { status: "idle" });
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const code = normalizeCode(inviteCode);

    // A code that is known to be bad stops signup here. The field's own
    // status line says what to do next (fix it, clear it, or continue without
    // one), so focus goes there rather than repeating it under the button.
    // An unreachable check is not a reason to block.
    if (code) {
      const result = await checkInviteCode(supabase, code);
      setCodeCheck(result);
      if (result.status === "invalid") {
        setLoading(false);
        inviteInputRef.current?.focus();
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

  // The invite card: who this link is for, while the code still stands a
  // chance. A refusal is reported by the field below instead, so the status
  // is never said twice.
  const showInviteCard =
    codeFromLink && normalizedCode.length > 0 && codeCheck.status !== "idle" && codeCheck.status !== "invalid";

  function continueWithoutCode() {
    setInviteCode("");
    setCodeFromLink(false);
    setCodeCheck({ status: "idle" });
    setError("");
    // Drop ?code= so a reload does not bring the dead code back.
    window.history.replaceState({}, "", "/signup");
  }

  return (
    <form onSubmit={handleSignup} className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        {showInviteCard && (
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
              ref={inviteInputRef}
              type="text"
              value={inviteCode}
              onChange={(e) => handleInviteCodeChange(e.target.value)}
              placeholder="e.g. ABC123"
              autoFocus={!codeFromLink}
              aria-describedby="invite-code-status"
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 mono uppercase"
            />
            {/* The one place the code's status is reported. While the invite
                card above is showing (a link whose code still stands), it
                already carries the checking / valid / unavailable line, so
                this only speaks up for a typed code or a refusal. */}
            <p id="invite-code-status" className="text-[10px] mt-1.5 min-h-[1em]">
              {!showInviteCard && codeCheck.status === "checking" && <span className="text-muted">Checking code</span>}
              {!showInviteCard && codeCheck.status === "valid" && (
                <span className="text-accent-green">
                  Valid code{inviteLabel ? `: ${inviteLabel}` : ""}
                </span>
              )}
              {!showInviteCard && codeCheck.status === "unavailable" && (
                <span className="text-muted">
                  Unable to check the code right now. It will be tried again when you create your account.
                </span>
              )}
              {codeCheck.status === "invalid" && codeFromLink && (
                <span className="text-accent-red">
                  This invite link is no longer valid. It may have expired or run out of seats. Ask whoever sent it for a new one, or{" "}
                  <button type="button" onClick={continueWithoutCode} className="font-medium underline hover:no-underline">
                    continue without a code
                  </button>
                  . You can set your preferences during setup.
                </span>
              )}
              {codeCheck.status === "invalid" && !codeFromLink && (
                <span className="text-accent-red">
                  This code is not valid. Check it for typos, or clear the field to sign up without one.
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
