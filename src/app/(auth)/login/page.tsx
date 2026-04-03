"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={handleLogin} className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
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
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
          />
        </div>
        {error && <p className="text-xs text-accent-red">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 text-sm font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </div>
      <p className="text-center text-xs text-muted">
        Don't have an account?{" "}
        <a href="/signup" className="text-accent-purple hover:underline">Sign up</a>
      </p>
    </form>
  );
}
