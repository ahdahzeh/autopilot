"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// "I got a job": pauses the daily search for this user (ingest, digest and
// nudges all skip profiles with hired_at set) and celebrates it. Resuming
// clears hired_at. Nothing else on the profile changes.
export function JobSearchStatus() {
  const supabase = createClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [hiredAt, setHiredAt] = useState<string | null>(null);
  const [company, setCompany] = useState("");
  const [saving, setSaving] = useState(false);
  const [justHired, setJustHired] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);
      const { data } = await supabase
        .from("profiles")
        .select("hired_at, hired_company")
        .eq("id", user.id)
        .single();
      setHiredAt(data?.hired_at ?? null);
      setCompany(data?.hired_company ?? "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markHired() {
    if (!userId) return;
    setSaving(true);
    setError("");
    const now = new Date().toISOString();
    const { error: err } = await supabase
      .from("profiles")
      .update({ hired_at: now, hired_company: company.trim() || null })
      .eq("id", userId);
    setSaving(false);
    if (err) {
      setError("Couldn't save that. Try again in a moment.");
      return;
    }
    setHiredAt(now);
    setJustHired(true);
  }

  async function resume() {
    if (!userId) return;
    setSaving(true);
    setError("");
    const { error: err } = await supabase
      .from("profiles")
      .update({ hired_at: null, hired_company: null })
      .eq("id", userId);
    setSaving(false);
    if (err) {
      setError("Couldn't resume your search. Try again in a moment.");
      return;
    }
    setHiredAt(null);
    setCompany("");
    setJustHired(false);
  }

  if (hiredAt) {
    return (
      <div className="rounded-lg border border-border bg-white p-4">
        <p className="text-2xl leading-none mb-2" aria-hidden>
          🎉
        </p>
        <p className="text-sm font-medium">
          {justHired ? "Congratulations on the new job!" : "You got the job."}
          {company ? ` ${company} is lucky to have you.` : ""}
        </p>
        <p className="text-xs text-muted mt-1">
          Your daily search and job emails are paused since{" "}
          {new Date(hiredAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.
          Your tracker, resumes and history stay right here.
        </p>
        <button onClick={resume} disabled={saving} className="cb-btn mt-4">
          {saving ? "Resuming…" : "Resume my search"}
        </button>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-muted mb-3">
        Landed a role? Mark it here and we&apos;ll pause your daily search and job emails. You can resume any time.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company (optional)"
          aria-label="Company you joined (optional)"
          className="flex-1 min-w-[180px] px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
        />
        <button onClick={markHired} disabled={saving || !userId} className="cb-btn">
          {saving ? "Saving…" : "I got a job 🎉"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
