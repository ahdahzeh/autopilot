"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

const SOURCES = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "builtin", label: "BuiltIn" },
  { id: "hiringcafe", label: "Hiring Cafe" },
  { id: "bandana", label: "Bandana" },
  { id: "welcometothejungle", label: "Welcome to the Jungle" },
];

const DAILY_LIMITS = [10, 20, 30];

type InviteCode = {
  id: string;
  code: string;
  used_by: string | null;
  prefilled_profile: Record<string, unknown> | null;
  expires_at: string;
  created_at: string;
};

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Profile fields
  const [displayName, setDisplayName] = useState("");
  const [titles, setTitles] = useState("");
  const [locations, setLocations] = useState("");
  const [salaryFloor, setSalaryFloor] = useState(0);
  const [sources, setSources] = useState<string[]>([]);
  const [dailyLimit, setDailyLimit] = useState(20);
  const [excludedCompanies, setExcludedCompanies] = useState("");

  // Invite codes
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
  const [newInviteTitles, setNewInviteTitles] = useState("");
  const [newInviteLocations, setNewInviteLocations] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);

  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();

      if (profile) {
        setDisplayName(profile.display_name || "");
        setTitles(profile.target_titles?.join(", ") || "");
        setLocations(profile.target_locations?.join(", ") || "");
        setSalaryFloor(profile.salary_floor || 0);
        setSources(profile.sources || []);
        setDailyLimit(profile.daily_job_limit || 20);
        setExcludedCompanies(profile.excluded_companies?.join(", ") || "");
        setIsAdmin(profile.is_admin || false);
      }

      if (profile?.is_admin) {
        const { data: codes } = await supabase
          .from("invite_codes")
          .select("*")
          .eq("created_by", user.id)
          .order("created_at", { ascending: false });
        setInviteCodes(codes || []);
      }

      setLoading(false);
    }
    load();
  }, [supabase]);

  async function handleSave() {
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    await supabase
      .from("profiles")
      .update({
        display_name: displayName,
        target_titles: titles.split(",").map((t) => t.trim()).filter(Boolean),
        target_locations: locations.split(",").map((l) => l.trim()).filter(Boolean),
        salary_floor: salaryFloor,
        sources,
        daily_job_limit: dailyLimit,
        excluded_companies: excludedCompanies.split(",").map((c) => c.trim()).filter(Boolean),
      })
      .eq("id", user.id);

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function toggleSource(id: string) {
    setSources((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  async function createInviteCode() {
    setCreatingInvite(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const prefill: Record<string, unknown> = {};
    if (newInviteTitles.trim()) {
      prefill.target_titles = newInviteTitles.split(",").map((t) => t.trim()).filter(Boolean);
    }
    if (newInviteLocations.trim()) {
      prefill.target_locations = newInviteLocations.split(",").map((l) => l.trim()).filter(Boolean);
    }

    const { data } = await supabase
      .from("invite_codes")
      .insert({
        code,
        created_by: user.id,
        prefilled_profile: Object.keys(prefill).length > 0 ? prefill : null,
      })
      .select()
      .single();

    if (data) {
      setInviteCodes((prev) => [data, ...prev]);
    }

    setNewInviteTitles("");
    setNewInviteLocations("");
    setCreatingInvite(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="mono text-sm text-muted animate-pulse">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-12 py-6" style={{ background: "var(--background)" }}>
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Auto<span className="text-accent-purple">pilot</span>
            </h1>
            <p className="text-[10px] text-muted mono uppercase tracking-widest mt-1">Settings</p>
          </div>
          <button
            onClick={() => router.push("/")}
            className="px-4 py-2 text-xs border border-border rounded-lg hover:bg-card transition-colors"
          >
            Back to Dashboard
          </button>
        </div>

        {/* Profile */}
        <Section title="Profile">
          <Field label="Display Name">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
            />
          </Field>
        </Section>

        {/* Job Preferences */}
        <Section title="Job Preferences">
          <Field label="Target Roles" hint="Comma-separated">
            <textarea
              value={titles}
              onChange={(e) => setTitles(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
            />
          </Field>

          <Field label="Locations" hint="Include 'Remote' if open to it">
            <textarea
              value={locations}
              onChange={(e) => setLocations(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
            />
          </Field>

          <Field label="Minimum Salary">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">$</span>
              <input
                type="number"
                value={salaryFloor || ""}
                onChange={(e) => setSalaryFloor(Number(e.target.value))}
                step={5000}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white mono focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
              />
            </div>
          </Field>

          <Field label="Excluded Companies" hint="Comma-separated, optional">
            <textarea
              value={excludedCompanies}
              onChange={(e) => setExcludedCompanies(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
            />
          </Field>
        </Section>

        {/* Sources */}
        <Section title="Job Sources">
          <div className="grid grid-cols-2 gap-2">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => toggleSource(s.id)}
                className={`text-left px-3 py-2.5 text-xs rounded-lg border transition-all ${
                  sources.includes(s.id)
                    ? "border-accent-purple bg-accent-purple/5 text-foreground font-medium"
                    : "border-border hover:bg-card text-muted"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </Section>

        {/* Daily Limit */}
        <Section title="Daily Job Limit">
          <div className="flex gap-2">
            {DAILY_LIMITS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setDailyLimit(n)}
                className={`flex-1 py-3 text-sm font-semibold rounded-lg border transition-all mono ${
                  dailyLimit === n
                    ? "border-accent-purple bg-accent-purple/5 text-foreground"
                    : "border-border hover:bg-card text-muted"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </Section>

        {/* Save */}
        <div className="flex items-center gap-3 mb-10">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2.5 text-sm font-semibold rounded-lg bg-accent-purple text-white hover:opacity-90 transition disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
          {saved && <span className="text-xs text-accent-green font-medium">Saved</span>}
        </div>

        {/* Invite Codes (admin only) */}
        {isAdmin && (
          <Section title="Invite Codes">
            <div className="bg-card border border-border rounded-xl p-4 space-y-4 mb-4">
              <p className="text-[10px] text-muted">
                Create invite codes for family members. Optionally prefill their job preferences.
              </p>
              <Field label="Prefill Roles" hint="Optional, comma-separated">
                <input
                  type="text"
                  value={newInviteTitles}
                  onChange={(e) => setNewInviteTitles(e.target.value)}
                  placeholder="e.g. Nurse, RN"
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
                />
              </Field>
              <Field label="Prefill Locations" hint="Optional, comma-separated">
                <input
                  type="text"
                  value={newInviteLocations}
                  onChange={(e) => setNewInviteLocations(e.target.value)}
                  placeholder="e.g. New York, Remote"
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
                />
              </Field>
              <button
                onClick={createInviteCode}
                disabled={creatingInvite}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition disabled:opacity-50"
              >
                {creatingInvite ? "Creating..." : "Generate Invite Code"}
              </button>
            </div>

            {inviteCodes.length > 0 && (
              <div className="space-y-2">
                {inviteCodes.map((ic) => (
                  <div
                    key={ic.id}
                    className="flex items-center justify-between px-4 py-3 border border-border rounded-xl bg-card"
                  >
                    <div>
                      <span className="mono text-sm font-bold tracking-wider">{ic.code}</span>
                      {ic.prefilled_profile && (
                        <span className="text-[9px] text-muted ml-2">
                          (prefilled)
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] mono text-muted">
                      {ic.used_by ? (
                        <span className="text-accent-green">Used</span>
                      ) : new Date(ic.expires_at) < new Date() ? (
                        <span className="text-accent-red">Expired</span>
                      ) : (
                        <span>Expires {new Date(ic.expires_at).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {/* Danger Zone */}
        <Section title="Account">
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/login";
            }}
            className="px-4 py-2 text-xs text-accent-red border border-accent-red/30 rounded-lg hover:bg-accent-red/5 transition"
          >
            Sign Out
          </button>
        </Section>
      </div>
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="text-xs font-medium block mb-1">
        {label}
        {hint && <span className="text-[9px] text-muted ml-1 font-normal">({hint})</span>}
      </label>
      {children}
    </div>
  );
}
