"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    // Validate invite code if provided
    if (inviteCode) {
      const { data: code } = await supabase
        .from("invite_codes")
        .select("*")
        .eq("code", inviteCode.trim().toUpperCase())
        .is("used_by", null)
        .gt("expires_at", new Date().toISOString())
        .single();

      if (!code) {
        setError("Invalid or expired invite code");
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

    // Claim invite code if used
    if (inviteCode && data.user) {
      await supabase
        .from("invite_codes")
        .update({ used_by: data.user.id })
        .eq("code", inviteCode.trim().toUpperCase());

      // Apply prefilled profile if exists
      const { data: code } = await supabase
        .from("invite_codes")
        .select("prefilled_profile")
        .eq("code", inviteCode.trim().toUpperCase())
        .single();

      if (code?.prefilled_profile) {
        await supabase
          .from("profiles")
          .update(code.prefilled_profile)
          .eq("id", data.user.id);
      }
    }

    router.push("/onboarding");
    router.refresh();
  }

  return (
    <form onSubmit={handleSignup} className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
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
        <div>
          <label className="text-[10px] uppercase tracking-widest text-muted font-medium block mb-1.5">
            Invite Code <span className="normal-case tracking-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="e.g. ABC123"
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 mono uppercase"
          />
        </div>
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
