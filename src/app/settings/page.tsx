"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { ResumeUpload } from "@/components/resume-upload";
import { TONES, MODELS, type Tone, type ModelChoice } from "@/lib/tailor-prompts";

const SOURCES = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "builtin", label: "BuiltIn" },
  { id: "hiringcafe", label: "Hiring Cafe" },
  { id: "greenhouse", label: "Greenhouse (ATS)" },
  { id: "lever", label: "Lever (ATS)" },
  { id: "ashby", label: "Ashby (ATS)" },
  { id: "bandana", label: "Bandana" },
  { id: "welcometothejungle", label: "Welcome to the Jungle" },
];

const ATS_SOURCE_IDS = new Set(["greenhouse", "lever", "ashby"]);

type TrackedCompany = {
  id: string;
  ats_type: "greenhouse" | "lever" | "ashby";
  slug: string;
  name: string;
  active: boolean;
  created_at: string;
};

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
  // Belt-and-suspenders: even if someone else somehow gets profile.is_admin=true,
  // the Admin button only surfaces for this hardcoded allowlist.
  const [isAdminAllowlisted, setIsAdminAllowlisted] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [resumeLength, setResumeLength] = useState(0);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [savedApiKey, setSavedApiKey] = useState(false);
  const [tailoringTone, setTailoringTone] = useState<Tone>("professional");
  const [tailoringModel, setTailoringModel] = useState<ModelChoice>("sonnet");
  const [savingTailorPrefs, setSavingTailorPrefs] = useState(false);
  const [savedTailorPrefs, setSavedTailorPrefs] = useState(false);
  const [tailorUsedToday, setTailorUsedToday] = useState(0);
  const TAILOR_DAILY_LIMIT = 40;
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState("");
  const [scrapeStarting, setScrapeStarting] = useState(false);

  // Pipeline cleanup — threshold in days, preview count, clearing state
  const [cleanupDays, setCleanupDays] = useState(8);
  const [cleanupPreview, setCleanupPreview] = useState<number | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupResult, setCleanupResult] = useState("");

  // Profile fields
  const [displayName, setDisplayName] = useState("");
  const [titles, setTitles] = useState("");
  const [locations, setLocations] = useState("");
  const [salaryFloor, setSalaryFloor] = useState(0);
  const [sources, setSources] = useState<string[]>([]);
  const [dailyLimit, setDailyLimit] = useState(20);
  const [excludedCompanies, setExcludedCompanies] = useState("");
  const [excludedTitles, setExcludedTitles] = useState("");
  const [minMatchScore, setMinMatchScore] = useState(0);

  // Invite codes
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
  const [newInviteTitles, setNewInviteTitles] = useState("");
  const [newInviteLocations, setNewInviteLocations] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);

  // Tracked companies (Greenhouse / Lever / Ashby)
  const [companies, setCompanies] = useState<TrackedCompany[]>([]);
  const [poolCount, setPoolCount] = useState(0);
  const [newCompanyUrl, setNewCompanyUrl] = useState("");
  const [newCompanyName, setNewCompanyName] = useState("");
  const [addingCompany, setAddingCompany] = useState(false);
  const [companyError, setCompanyError] = useState("");

  const router = useRouter();
  const supabase = createClient();

  // Handle OAuth redirect result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail") === "connected") {
      setGmailConnected(true);
      window.history.replaceState({}, "", "/settings");
    }
  }, []);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Hardcoded email allowlist — keep in sync with ADMIN_EMAILS in
      // server-side admin routes if you add more gates there.
      const ADMIN_EMAILS = new Set(["adaze.oviawe@gmail.com"]);
      setIsAdminAllowlisted(ADMIN_EMAILS.has((user.email || "").toLowerCase()));

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
        setExcludedTitles(profile.excluded_titles?.join(", ") || "");
        setMinMatchScore(profile.min_match_score ?? 0);
        setIsAdmin(profile.is_admin || false);
        setGmailConnected(profile.gmail_connected || false);
        setResumeLength(profile.resume_text?.length || 0);
        setAnthropicApiKey(profile.anthropic_api_key || "");
        setTailoringTone((profile.tailoring_tone as Tone) || "professional");
        setTailoringModel((profile.tailoring_model as ModelChoice) || "sonnet");
      }

      if (profile?.is_admin) {
        const { data: codes } = await supabase
          .from("invite_codes")
          .select("*")
          .eq("created_by", user.id)
          .order("created_at", { ascending: false });
        setInviteCodes(codes || []);
      }

      const day = new Date().toISOString().slice(0, 10);
      const { data: usage } = await supabase
        .from("tailor_usage")
        .select("count")
        .eq("user_id", user.id)
        .eq("day", day)
        .maybeSingle();
      setTailorUsedToday((usage?.count as number | undefined) ?? 0);

      try {
        const res = await fetch("/api/companies");
        if (res.ok) {
          const json = (await res.json()) as { companies: TrackedCompany[]; pool_count: number };
          setCompanies(json.companies ?? []);
          setPoolCount(json.pool_count ?? 0);
        }
      } catch {
        // Non-fatal — tracked companies is additive to the existing flow.
      }

      setLoading(false);
    }
    load();
  }, [supabase]);

  async function addCompany() {
    setAddingCompany(true);
    setCompanyError("");
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newCompanyUrl.trim(), name: newCompanyName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCompanyError(data.error || "Could not add company");
        return;
      }
      setCompanies((prev) => {
        const without = prev.filter((c) => c.id !== data.company.id);
        return [data.company, ...without];
      });
      setPoolCount((n) => n + 1);
      setNewCompanyUrl("");
      setNewCompanyName("");
    } finally {
      setAddingCompany(false);
    }
  }

  async function removeCompany(id: string) {
    const prev = companies;
    setCompanies((cs) => cs.filter((c) => c.id !== id));
    const res = await fetch(`/api/companies?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      // Restore on failure so the user sees the real state.
      setCompanies(prev);
      const data = await res.json().catch(() => ({}));
      setCompanyError(data.error || "Could not remove company");
    }
  }

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
        excluded_titles: excludedTitles.split(",").map((t) => t.trim()).filter(Boolean),
        min_match_score: Math.max(0, Math.min(10, minMatchScore)),
      })
      .eq("id", user.id);

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function saveApiKey() {
    setSavingApiKey(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("profiles").update({ anthropic_api_key: anthropicApiKey.trim() }).eq("id", user.id);
      setSavedApiKey(true);
      setTimeout(() => setSavedApiKey(false), 2000);
    } finally {
      setSavingApiKey(false);
    }
  }

  async function saveTailorPrefs() {
    setSavingTailorPrefs(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase
        .from("profiles")
        .update({ tailoring_tone: tailoringTone, tailoring_model: tailoringModel })
        .eq("id", user.id);
      setSavedTailorPrefs(true);
      setTimeout(() => setSavedTailorPrefs(false), 2000);
    } finally {
      setSavingTailorPrefs(false);
    }
  }

  // Fetch the preview count whenever the threshold slider changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/bulk-delete?days=${cleanupDays}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setCleanupPreview(typeof data.count === "number" ? data.count : null);
      } catch {
        if (!cancelled) setCleanupPreview(null);
      }
    })();
    return () => { cancelled = true; };
  }, [cleanupDays]);

  async function clearOldJobs() {
    if (cleanupPreview === 0) return;
    const ok = confirm(
      `Permanently delete ${cleanupPreview ?? "?"} job(s) older than ${cleanupDays} days? This cannot be undone.`,
    );
    if (!ok) return;

    setCleanupLoading(true);
    setCleanupResult("");
    try {
      const res = await fetch("/api/jobs/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ olderThanDays: cleanupDays }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCleanupResult(`Failed: ${data.error || res.statusText}`);
      } else {
        setCleanupResult(`Deleted ${data.deleted} job(s).`);
        setCleanupPreview(0);
      }
    } catch (err) {
      setCleanupResult(`Failed: ${String(err)}`);
    } finally {
      setCleanupLoading(false);
    }
  }

  async function syncGmail() {
    setSyncing(true);
    setSyncResult("");
    try {
      const res = await fetch("/api/gmail/sync");
      const data = await res.json();
      if (data.error) {
        setSyncResult("Sync failed: " + data.error);
      } else {
        setSyncResult(`Done. ${data.updated ?? 0} job(s) updated from ${data.emails_scanned ?? 0} emails.`);
      }
    } catch {
      setSyncResult("Sync failed. Try again.");
    } finally {
      setSyncing(false);
    }
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
              <div className="cb-brand__sub">Settings</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && isAdminAllowlisted && (
              <a href="/admin" className="cb-btn" title="Admin dashboard">
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 2L3 7v6c0 5 3.5 9 9 11 5.5-2 9-6 9-11V7l-9-5z" />
                </svg>
                Admin
              </a>
            )}
            <button onClick={() => router.push("/")} className="cb-btn">
              ← Back
            </button>
          </div>
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

          <Field
            label="Excluded Title Keywords"
            hint="Substring match, comma-separated. e.g. graphic, brand, junior"
          >
            <textarea
              value={excludedTitles}
              onChange={(e) => setExcludedTitles(e.target.value)}
              rows={2}
              placeholder="graphic, brand, web designer, junior"
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
            />
          </Field>

          <Field
            label="Minimum Match Score"
            hint="0–10 against your resume. Jobs below this are not added. 0 disables."
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={minMatchScore}
                onChange={(e) => setMinMatchScore(Number(e.target.value))}
                className="flex-1"
              />
              <span className="mono text-sm w-8 text-right">{minMatchScore}</span>
            </div>
          </Field>
        </Section>

        {/* Sources */}
        <Section title="Job Sources">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
          {sources.some((s) => ATS_SOURCE_IDS.has(s)) && companies.length === 0 && (
            <p className="text-[10px] text-muted mt-2">
              ATS sources need at least one company in Tracked Companies below to return jobs.
            </p>
          )}
        </Section>

        {/* Tracked Companies (ATS) */}
        <Section title="Tracked Companies">
          {/* Community pool banner */}
          <div className="flex items-center justify-between px-4 py-3 border border-border rounded-xl bg-card mb-3">
            <div>
              <p className="text-xs font-semibold">Community pool</p>
              <p className="text-[10px] text-muted mt-0.5">
                Scraped for every user with Greenhouse / Lever / Ashby enabled
              </p>
            </div>
            <span className="mono text-sm font-bold tabular-nums">
              {poolCount > 0 ? poolCount : "—"}
            </span>
          </div>

          {/* Add form */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-3 mb-3">
            <p className="text-[10px] text-muted">
              Add a company by its ATS board URL. Your addition joins the community pool — every user benefits automatically.
            </p>
            <Field label="Board URL" hint="jobs.lever.co/... · boards.greenhouse.io/... · jobs.ashbyhq.com/...">
              <input
                type="text"
                value={newCompanyUrl}
                onChange={(e) => setNewCompanyUrl(e.target.value)}
                placeholder="https://jobs.lever.co/notion"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
              />
            </Field>
            <Field label="Display Name" hint="Optional. Defaults to the URL slug.">
              <input
                type="text"
                value={newCompanyName}
                onChange={(e) => setNewCompanyName(e.target.value)}
                placeholder="Notion"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
              />
            </Field>
            <div className="flex items-center gap-3">
              <button
                onClick={addCompany}
                disabled={addingCompany || !newCompanyUrl.trim()}
                className="cb-btn cb-btn--solid"
              >
                {addingCompany ? "Adding" : "Add company"}
              </button>
              {companyError && (
                <span className="mono text-[10px] uppercase tracking-widest" style={{ color: "var(--danger)" }}>
                  {companyError}
                </span>
              )}
            </div>
          </div>

          {/* User's own additions */}
          {companies.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[10px] text-muted uppercase tracking-widest font-medium mb-1">Your additions</p>
              {companies.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 px-4 py-3 border border-border rounded-xl bg-card"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold truncate">{c.name || c.slug}</p>
                      <span className="mono text-[8px] uppercase tracking-widest px-1.5 py-0.5 rounded border border-border text-muted">
                        In pool
                      </span>
                    </div>
                    <p className="text-[9px] mono text-muted uppercase tracking-widest">
                      {c.ats_type} · {c.slug}
                    </p>
                  </div>
                  <button
                    onClick={() => removeCompany(c.id)}
                    className="text-[10px] mono uppercase tracking-widest text-muted hover:text-accent-red transition-colors shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted">No additions yet. Be the first to grow the pool.</p>
          )}
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
          <button onClick={handleSave} disabled={saving} className="cb-btn cb-btn--solid">
            {saving ? "Saving" : "Save changes"}
          </button>
          {saved && <span className="mono text-[10px] uppercase tracking-widest" style={{ color: "var(--success)" }}>Saved</span>}
        </div>

        {/* Pipeline cleanup */}
        <Section title="Clear Old Jobs">
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <p className="text-[10px] text-muted">
              Permanently remove stale jobs from your pipeline. Tailorings, bullets, and any
              Applied / Interview status attached to those jobs go with them.
            </p>

            <Field
              label="Older than"
              hint="Applies to the job's original posting date"
            >
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={3}
                  max={60}
                  step={1}
                  value={cleanupDays}
                  onChange={(e) => setCleanupDays(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="mono text-sm w-16 text-right tabular-nums">
                  {cleanupDays} day{cleanupDays === 1 ? "" : "s"}
                </span>
              </div>
            </Field>

            <div className="flex items-center justify-between text-[10px] mono uppercase tracking-widest">
              <span className="text-muted">Will delete</span>
              <span className="font-bold tabular-nums">
                {cleanupPreview === null ? "—" : `${cleanupPreview} job${cleanupPreview === 1 ? "" : "s"}`}
              </span>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={clearOldJobs}
                disabled={cleanupLoading || !cleanupPreview}
                className="cb-btn cb-btn--danger"
              >
                {cleanupLoading ? "Deleting" : "Delete now"}
              </button>
              {cleanupResult && (
                <span
                  className="mono text-[10px] uppercase tracking-widest"
                  style={{ color: cleanupResult.startsWith("Failed") ? "var(--danger)" : "var(--success)" }}
                >
                  {cleanupResult}
                </span>
              )}
            </div>
          </div>
        </Section>

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
              <button onClick={createInviteCode} disabled={creatingInvite} className="cb-btn cb-btn--solid">
                {creatingInvite ? "Creating" : "Generate code"}
              </button>
            </div>

            {inviteCodes.length > 0 && (
              <div className="space-y-2">
                {inviteCodes.map((ic) => (
                  <div
                    key={ic.id}
                    className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-1 px-4 py-3 border border-border rounded-xl bg-card"
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

        {/* Schedule */}
        <Section title="Update Schedule">
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-xl">🕗</span>
              <div className="flex-1">
                <p className="text-sm font-semibold">Daily at 13:00 UTC (9 AM ET / 6 AM PT)</p>
                <p className="text-[10px] text-muted mt-1">
                  Fresh jobs are scraped automatically every morning. You can also trigger a scrape manually below. Results will appear on your dashboard in 1 to 2 minutes.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={scrapeStarting}
              onClick={async () => {
                setScrapeStarting(true);
                try {
                  const res = await fetch("/api/jobs/scrape", { method: "POST" });
                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    alert(`Could not start scrape: ${data.error || res.statusText}`);
                    setScrapeStarting(false);
                    return;
                  }
                  router.push("/?welcome=1");
                } catch (err) {
                  alert(`Could not start scrape: ${String(err)}`);
                  setScrapeStarting(false);
                }
              }}
              className="cb-btn cb-btn--solid"
            >
              {scrapeStarting ? "Starting" : "Run scrape now"}
            </button>
          </div>
        </Section>

        {/* Resume */}
        <Section title="Resume">
          <p className="text-[10px] text-muted mb-3">
            Used to score job matches and extract keywords for smarter scraping.
          </p>
          <ResumeUpload
            onUploaded={(len) => setResumeLength(len)}
            existingLength={resumeLength}
          />
        </Section>

        {/* Gmail */}
        <Section title="Gmail Sync">
          {gmailConnected ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between px-4 py-3 border border-border rounded-xl bg-card">
                <div className="flex items-center gap-3">
                  <span className="text-xl">📬</span>
                  <div>
                    <p className="text-sm font-semibold">Gmail Connected</p>
                    <p className="text-[10px] text-muted">Pipeline updates automatically from your inbox + calendar</p>
                  </div>
                </div>
                <span className="text-[10px] text-accent-green font-medium mono">Active</span>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <button onClick={syncGmail} disabled={syncing} className="cb-btn cb-btn--solid">
                  {syncing ? "Syncing" : "Sync now"}
                </button>
                <a
                  href="/api/gmail/connect?origin=settings"
                  className="cb-btn text-[10px]"
                  title="Re-authorize to grant calendar read access for interview detection"
                >
                  Reconnect Google
                </a>
                {syncResult && (
                  <span
                    className="mono text-[10px] uppercase tracking-widest"
                    style={{ color: syncResult.startsWith("Sync failed") ? "var(--danger)" : "var(--success)" }}
                  >
                    {syncResult}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted">
                If interviews aren&apos;t showing up, click <strong>Reconnect Google</strong> to grant calendar access.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[10px] text-muted">
                Connect Gmail to auto-update job statuses when you get interview requests, rejections, or offers.
              </p>
              <a
                href="/api/gmail/connect"
                className="flex items-center gap-3 px-4 py-3 border border-border rounded-xl hover:bg-card transition-colors"
              >
                <span className="text-xl">📬</span>
                <div>
                  <p className="text-sm font-semibold">Connect Gmail</p>
                  <p className="text-[10px] text-muted">Read-only access · OAuth secured</p>
                </div>
              </a>
            </div>
          )}
        </Section>

        {/* AI Tailoring */}
        <Section title="AI Tailoring">
          {(() => {
            const remaining = Math.max(0, TAILOR_DAILY_LIMIT - tailorUsedToday);
            const pct = Math.min(100, Math.round((tailorUsedToday / TAILOR_DAILY_LIMIT) * 100));
            const hasOwnKey = anthropicApiKey.trim().length > 0;
            const tone =
              hasOwnKey ? "ok" :
              remaining === 0 ? "danger" :
              remaining <= 5 ? "warn" : "ok";
            return (
              <div className="bg-card border border-border rounded-xl p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold">Daily tailoring usage</p>
                  <p className="mono text-[11px] text-muted">
                    {tailorUsedToday} / {TAILOR_DAILY_LIMIT}
                  </p>
                </div>
                <div className="h-1.5 w-full bg-border/50 rounded-full overflow-hidden">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${hasOwnKey ? 0 : pct}%`,
                      background:
                        tone === "danger" ? "var(--accent-red)" :
                        tone === "warn" ? "var(--accent)" :
                        "var(--accent-purple)",
                    }}
                  />
                </div>
                <p className="text-[10px] text-muted mt-2">
                  {hasOwnKey
                    ? "Using your own Anthropic key. No daily cap applies."
                    : remaining === 0
                      ? "Daily cap reached. Resets at midnight UTC, or add your own key below."
                      : `${remaining} tailoring runs left today. Resets at midnight UTC.`}
                </p>
              </div>
            );
          })()}

          <Field label="Writing Tone" hint="Applied to bullets, cover letters, and prep">
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(TONES) as Tone[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTailoringTone(t)}
                  className={`text-left px-3 py-2 text-xs rounded-lg border transition-all ${
                    tailoringTone === t
                      ? "border-accent-purple bg-accent-purple/5 text-foreground"
                      : "border-border hover:bg-card text-muted"
                  }`}
                >
                  <p className="font-semibold">{TONES[t].label}</p>
                  <p className="text-[9px] text-muted mt-0.5">{TONES[t].description}</p>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Model" hint="Trade speed for depth">
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(MODELS) as ModelChoice[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setTailoringModel(m)}
                  className={`text-left px-3 py-2 text-xs rounded-lg border transition-all ${
                    tailoringModel === m
                      ? "border-accent-purple bg-accent-purple/5 text-foreground"
                      : "border-border hover:bg-card text-muted"
                  }`}
                >
                  <p className="font-semibold">{MODELS[m].label}</p>
                  <p className="text-[9px] text-muted mt-0.5">{MODELS[m].description}</p>
                </button>
              ))}
            </div>
          </Field>

          <div className="flex items-center gap-3 mt-2 mb-5">
            <button onClick={saveTailorPrefs} disabled={savingTailorPrefs} className="cb-btn cb-btn--solid">
              {savingTailorPrefs ? "Saving" : "Save preferences"}
            </button>
            {savedTailorPrefs && <span className="mono text-[10px] uppercase tracking-widest" style={{ color: "var(--success)" }}>Saved</span>}
          </div>

          <p className="text-[10px] text-muted mb-3">
            Optionally add your own Anthropic API key to bill tailoring usage to your own account instead of the shared pool.
          </p>
          <Field label="Anthropic API Key">
            <input
              type="password"
              value={anthropicApiKey}
              onChange={(e) => setAnthropicApiKey(e.target.value)}
              placeholder="sk-ant-..."
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white font-mono focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
            />
          </Field>
          <div className="flex items-center gap-3 mt-2">
            <button onClick={saveApiKey} disabled={savingApiKey} className="cb-btn cb-btn--solid">
              {savingApiKey ? "Saving" : "Save key"}
            </button>
            {savedApiKey && <span className="mono text-[10px] uppercase tracking-widest" style={{ color: "var(--success)" }}>Saved</span>}
          </div>

          <a
            href="/stories"
            className="inline-block mt-5 text-xs text-accent-purple hover:opacity-70"
          >
            View your story bank →
          </a>
        </Section>

        {/* Account */}
        <Section title="Account">
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/login";
            }}
            className="cb-btn cb-btn--danger"
          >
            Sign out
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
