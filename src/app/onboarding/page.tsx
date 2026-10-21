"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { ResumeUpload } from "@/components/resume-upload";

// Every source with a real scraper module. Bandana and Welcome-to-the-Jungle
// were retired but kept appearing in profile.sources, burning ~25% of each
// user's source budget on "unknown source" no-ops, so they are not offered.
// Workday joined in 2026-10: its employers live in target_companies with
// ats_type = 'workday', so like the other ATS sources it needs no setup from
// the user. LinkedIn ordered last because it's slow and frequently throttled.
const SOURCES = [
  { id: "hiringcafe", label: "Hiring Cafe" },
  { id: "builtin", label: "BuiltIn" },
  { id: "greenhouse", label: "Greenhouse (ATS)" },
  { id: "lever", label: "Lever (ATS)" },
  { id: "ashby", label: "Ashby (ATS)" },
  { id: "workday", label: "Company career sites (Workday)" },
  { id: "linkedin", label: "LinkedIn" },
];

const DAILY_LIMITS = [10, 20, 30];

type RoleFamily = "design" | "engineering" | "product" | "data" | "marketing" | "ops" | "other";

type VerticalPack = {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  ats_slugs: Array<{ ats_type: string; slug: string; name: string }>;
};

const ROLE_FAMILIES: { id: RoleFamily; label: string; titlePlaceholder: string; locationPlaceholder: string }[] = [
  { id: "design", label: "Design", titlePlaceholder: "Product Designer, Senior Product Designer, UX Designer", locationPlaceholder: "San Francisco, New York, Remote" },
  { id: "engineering", label: "Engineering", titlePlaceholder: "Software Engineer, Senior Frontend Engineer, Staff Engineer", locationPlaceholder: "San Francisco, New York, Remote" },
  { id: "product", label: "Product", titlePlaceholder: "Product Manager, Senior PM, Group Product Manager", locationPlaceholder: "San Francisco, New York, Remote" },
  { id: "data", label: "Data & ML", titlePlaceholder: "Data Scientist, Analytics Engineer, ML Engineer", locationPlaceholder: "San Francisco, New York, Remote" },
  { id: "marketing", label: "Marketing & Growth", titlePlaceholder: "Growth Marketer, Lifecycle Marketing, Brand Marketing Lead", locationPlaceholder: "New York, Los Angeles, Remote" },
  { id: "ops", label: "Operations", titlePlaceholder: "Business Operations, Program Manager, Chief of Staff", locationPlaceholder: "New York, San Francisco, Remote" },
  { id: "other", label: "Something else", titlePlaceholder: "Your target titles, comma separated", locationPlaceholder: "Cities you want to work in, comma separated" },
];

// The full flow, in order. Which of these a given member actually sees is
// decided by visibleStepKeys() below.
type StepKey = "welcome" | "family" | "targeting" | "prefs" | "sources" | "focus" | "resume" | "gmail" | "review";
const STEP_ORDER: StepKey[] = ["welcome", "family", "targeting", "prefs", "sources", "focus", "resume", "gmail", "review"];

// Steps an invite can answer on the member's behalf. A step is skipped when
// the code's prefilled_profile covered every field listed for it; the list of
// covered fields comes from my_invite_redemption() (migration 020). The Per
// Scholas presets in src/lib/track-presets.ts cover all five, so a cohort
// member sees welcome, resume, Gmail and review only. Resume and Gmail are
// never skipped: a resume is required and only the member can connect Gmail.
const STEP_PREREQS: Partial<Record<StepKey, string[]>> = {
  family: ["role_family"],
  targeting: ["target_titles", "target_locations"],
  prefs: ["salary_floor", "daily_job_limit"],
  sources: ["sources"],
  focus: ["priority_industries"],
};

function visibleStepKeys(prefilledFields: string[]): StepKey[] {
  return STEP_ORDER.filter((key) => {
    const needs = STEP_PREREQS[key];
    return !needs || !needs.every((field) => prefilledFields.includes(field));
  });
}

// The invite this member redeemed at signup and which profile fields it set.
type InviteInfo = { code: string; label: string | null; prefilledFields: string[] };

// Plain-English list of what the invite filled in, for the welcome copy.
// Names each skipped step by what the member would have typed there.
function describePrefilled(fields: string[]): string {
  const parts: string[] = [];
  if (fields.includes("target_titles")) parts.push("target roles");
  if (fields.includes("target_locations")) parts.push("locations");
  if (fields.includes("salary_floor") || fields.includes("daily_job_limit")) parts.push("pipeline preferences");
  if (fields.includes("sources")) parts.push("job sources");
  if (fields.includes("priority_industries")) parts.push("focus areas");
  if (parts.length === 0) return "preferences";
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(parts);
}

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [returningUser, setReturningUser] = useState(false);
  const [invite, setInvite] = useState<InviteInfo | null>(null);

  // Mirrors profileLoaded for code that runs outside render. saveProgress()
  // refuses to write before loadProfile() has finished: the welcome button
  // is reachable while the profile is still loading, and a save at that
  // moment would push the form defaults (role_family "design", the default
  // sources, limit 20) over whatever the invite prefilled or a previous
  // session saved. A ref so the check cannot go stale inside async closures.
  const profileLoadedRef = useRef(false);

  // Form state
  const [roleFamily, setRoleFamily] = useState<RoleFamily>("design");
  const [titles, setTitles] = useState("");
  const [locations, setLocations] = useState("");
  const [salaryFloor, setSalaryFloor] = useState(0);
  // Include every scraper source by default so users get maximum job yield
  // out of the box. ATS integrations (greenhouse/lever/ashby/workday) draw
  // from a shared community-seeded company pool, so users benefit without
  // configuring tracked companies themselves. Prune in Settings if needed.
  //
  // Order matters: LinkedIn goes LAST because it's the slowest and most
  // frequently bot-detected source. If the scraper runs sequentially, this
  // ensures the fast sources populate the feed before LinkedIn might hang.
  const [sources, setSources] = useState<string[]>([
    "hiringcafe",
    "builtin",
    "greenhouse",
    "lever",
    "ashby",
    "workday",
    "linkedin",
  ]);
  const [dailyLimit, setDailyLimit] = useState(20);
  const [excludedCompanies, setExcludedCompanies] = useState("");
  const [resumeUploaded, setResumeUploaded] = useState(false);
  const [resumeLength, setResumeLength] = useState(0);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [priorityIndustries, setPriorityIndustries] = useState("");
  const [priorityKeywords, setPriorityKeywords] = useState("");
  const [selectedVerticalIds, setSelectedVerticalIds] = useState<string[]>([]);
  const [verticalPacks, setVerticalPacks] = useState<VerticalPack[]>([]);

  const router = useRouter();
  const supabase = createClient();

  // Persist partial onboarding state to the DB. Called on every Next and
  // before the Gmail OAuth redirect. This protects users from losing form
  // state during OAuth full-page redirects, tab closes, or browser crashes.
  //
  // Critical: never sets `onboarded: true`. That only happens in
  // handleComplete. The partial save just preserves what the user has
  // entered so loadProfile() can rehydrate them on return.
  async function saveProgress() {
    // See profileLoadedRef: before the profile is in, the form holds
    // defaults, not the user's data, and must not be written back.
    if (!profileLoadedRef.current) return;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const targetTitles = titles.split(",").map((t) => t.trim()).filter(Boolean);
    const targetLocations = locations.split(",").map((l) => l.trim()).filter(Boolean);
    const excluded = excludedCompanies.split(",").map((c) => c.trim()).filter(Boolean);
    const priorityInds = priorityIndustries.split(",").map((s) => s.trim()).filter(Boolean);
    const priorityKws = priorityKeywords.split(",").map((s) => s.trim()).filter(Boolean);

    // Only write fields the user has actually filled in. Writing empty
    // arrays on an early-step save would clobber data from a previous
    // in-progress attempt.
    const update: Record<string, unknown> = {
      role_family: roleFamily,
      salary_floor: salaryFloor,
      sources,
      daily_job_limit: dailyLimit,
    };
    if (targetTitles.length > 0) update.target_titles = targetTitles;
    if (targetLocations.length > 0) update.target_locations = targetLocations;
    if (excluded.length > 0) update.excluded_companies = excluded;
    if (priorityInds.length > 0) update.priority_industries = priorityInds;
    if (priorityKws.length > 0) update.priority_keywords = priorityKws;

    try {
      await supabase.from("profiles").update(update).eq("id", user.id);
    } catch {
      // Non-fatal: if the save fails, the next Next will retry.
    }
  }

  async function goNext() {
    // Save in background; don't block navigation. If the network drops,
    // the user still advances and will retry on the next step.
    void saveProgress();
    setStep((s) => s + 1);
  }

  const currentFamily = useMemo(
    () => ROLE_FAMILIES.find((f) => f.id === roleFamily) ?? ROLE_FAMILIES[0],
    [roleFamily],
  );

  useEffect(() => {
    async function loadProfile() {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        // The profile and the invite the member redeemed at signup (if any)
        // are independent reads, so fetch them together. The invite RPC
        // arrives with migration 020; until it exists (PostgREST PGRST202),
        // or if it fails for any reason, the member is treated as uninvited
        // and sees the full flow. Nothing else depends on it.
        const [{ data: profile }, inviteResult] = await Promise.all([
          supabase.from("profiles").select("*").eq("id", user.id).single(),
          supabase.rpc("my_invite_redemption").then(
            (res) => res,
            () => ({ data: null, error: null }),
          ),
        ]);

        let inviteFields: string[] = [];
        const inviteRow = inviteResult.data as
          | { code?: string; label?: string | null; prefilled_fields?: unknown }
          | null;
        // The skip rules hide steps on the promise that the profile row already
        // holds the answers, so the invite only counts when the profile read
        // came back too. Without this a member whose profile fetch failed
        // would reach review with empty roles, a disabled finish button and no
        // step left to type them in.
        if (!inviteResult.error && inviteRow?.code && profile) {
          inviteFields = Array.isArray(inviteRow.prefilled_fields)
            ? inviteRow.prefilled_fields.filter((f): f is string => typeof f === "string")
            : [];
          // Same guard for the two fields review insists on: if the row does
          // not actually hold them (a code whose prefill carried empty lists),
          // keep the roles + locations step visible.
          if (!(profile.target_titles?.length > 0) || !(profile.target_locations?.length > 0)) {
            inviteFields = inviteFields.filter((f) => f !== "target_titles" && f !== "target_locations");
          }
          setInvite({ code: inviteRow.code, label: inviteRow.label ?? null, prefilledFields: inviteFields });
        }

        // Rehydrate form state from any previously-saved fields. We check
        // each field independently so a returning user who filled out only
        // roles (not locations) gets their roles back. This is what
        // prevents the Gmail-OAuth data wipe: saveProgress() persists
        // these fields before the redirect, and this restores them after.
        if (profile) {
          if (profile.target_titles?.length > 0) {
            setTitles(profile.target_titles.join(", "));
          }
          if (profile.target_locations?.length > 0) {
            setLocations(profile.target_locations.join(", "));
          }
          if (profile.salary_floor) setSalaryFloor(profile.salary_floor);
          if (profile.sources?.length > 0) setSources(profile.sources);
          if (profile.daily_job_limit) setDailyLimit(profile.daily_job_limit);
          if (profile.excluded_companies?.length > 0) {
            setExcludedCompanies(profile.excluded_companies.join(", "));
          }
          if (profile.role_family) setRoleFamily(profile.role_family as RoleFamily);
          if (profile.priority_industries?.length > 0) {
            setPriorityIndustries(profile.priority_industries.join(", "));
          }
          if (profile.priority_keywords?.length > 0) {
            setPriorityKeywords(profile.priority_keywords.join(", "));
          }

          // Any persisted field counts as returning progress, including
          // invite-prefilled rows (target_titles) and mid-flow partial
          // saves (role_family). The actual step jump to the review
          // screen happens below when ?gmail=connected is present.
          const hasAnyProgress =
            profile.target_titles?.length > 0 ||
            profile.target_locations?.length > 0 ||
            profile.role_family;
          if (hasAnyProgress) {
            setPrefilled(true);
            // Distinguish a returning partial onboarder from a fresh
            // arrival. Before 020 only partial saves wrote role_family, so
            // its presence meant "returning". Track presets prefill
            // role_family too, so for an invited member the tell is work
            // only they could have done: a saved resume or a connected
            // Gmail.
            const returning = inviteFields.length > 0
              ? profile.resume_text?.length > 0 || profile.gmail_connected
              : Boolean(profile.role_family);
            if (returning && !profile.onboarded) {
              setReturningUser(true);
            }
          }
        }
        if (profile?.resume_text?.length > 0) {
          setResumeUploaded(true);
          setResumeLength(profile.resume_text.length);
        }
        if (profile?.gmail_connected) {
          setGmailConnected(true);
        }

        // Load vertical packs (shared reference data). If this fails,
        // the verticals step renders a "Loading…" placeholder and the
        // user can still advance without selecting any.
        try {
          const { data: packs } = await supabase
            .from("vertical_packs")
            .select("*")
            .eq("active", true)
            .order("slug");
          if (packs) setVerticalPacks(packs as VerticalPack[]);
        } catch {
          // Non-fatal: step remains passable.
        }

        // Rehydrate previously-selected verticals for returning users.
        try {
          const { data: pv } = await supabase
            .from("profile_verticals")
            .select("vertical_pack_id")
            .eq("user_id", user.id);
          if (pv && pv.length > 0) {
            setSelectedVerticalIds(pv.map((row: { vertical_pack_id: string }) => row.vertical_pack_id));
          }
        } catch {
          // Non-fatal.
        }

        const params = new URLSearchParams(window.location.search);
        if (params.get("gmail") === "connected") {
          setGmailConnected(true);
          // Jump to review. The index comes from the same skip rules the
          // render uses, with the invite fields loaded above, so a cohort
          // member (four visible steps) lands on review rather than past
          // the end of the list.
          setStep(visibleStepKeys(inviteFields).indexOf("review"));
          window.history.replaceState({}, "", "/onboarding");
        }
      } finally {
        // Always unblock the button. The handleComplete guard (checking
        // non-empty titles/locations) is the real data safety. profileLoaded
        // only prevents a click during the brief fetch window; a fetch error
        // should never permanently disable the button.
        profileLoadedRef.current = true;
        setProfileLoaded(true);
      }
    }
    loadProfile();
  }, [supabase]);

  async function handleComplete() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }

    const targetTitles = titles.split(",").map((t) => t.trim()).filter(Boolean);
    const targetLocations = locations.split(",").map((l) => l.trim()).filter(Boolean);
    const excluded = excludedCompanies.split(",").map((c) => c.trim()).filter(Boolean);
    const priorityInds = priorityIndustries.split(",").map((s) => s.trim()).filter(Boolean);
    const priorityKws = priorityKeywords.split(",").map((s) => s.trim()).filter(Boolean);

    // Refuse to overwrite with empty values. Prevents the Gmail-OAuth return
    // race where the review step renders before loadProfile() repopulates form
    // state, which silently wiped users' onboarding data in the past.
    if (targetTitles.length === 0 || targetLocations.length === 0) {
      setLoading(false);
      alert("Please go back and fill in your target titles and locations before finishing.");
      return;
    }

    await supabase
      .from("profiles")
      .update({
        target_titles: targetTitles,
        target_locations: targetLocations,
        salary_floor: salaryFloor,
        sources,
        daily_job_limit: dailyLimit,
        excluded_companies: excluded,
        role_family: roleFamily,
        priority_industries: priorityInds,
        priority_keywords: priorityKws,
        onboarded: true,
      })
      .eq("id", user.id);

    // Persist vertical selections. Delete-then-insert keeps the set in
    // sync with what's currently checked (a returning user who unchecks
    // a pack should see it removed). Failures here are non-fatal: the
    // main profile write already succeeded.
    try {
      await supabase.from("profile_verticals").delete().eq("user_id", user.id);
      if (selectedVerticalIds.length > 0) {
        await supabase.from("profile_verticals").insert(
          selectedVerticalIds.map((vid) => ({ user_id: user.id, vertical_pack_id: vid })),
        );

        // Expand each selected pack into per-company target rows so the
        // scraper picks them up. `on conflict do nothing` protects users
        // who have already added one of these companies manually.
        const selectedPacks = verticalPacks.filter((p) => selectedVerticalIds.includes(p.id));
        const companyRows = selectedPacks.flatMap((pack) =>
          (pack.ats_slugs || []).map((s) => ({
            user_id: user.id,
            ats_type: s.ats_type,
            slug: s.slug,
            name: s.name,
            active: true,
          })),
        );
        if (companyRows.length > 0) {
          await supabase
            .from("target_companies")
            .upsert(companyRows, { onConflict: "user_id,ats_type,slug", ignoreDuplicates: true });
        }
      }
    } catch {
      // Non-fatal: user can manage verticals/companies from Settings.
    }

    try {
      await fetch("/api/jobs/scrape", { method: "POST" });
    } catch {
      // Non-fatal: the daily cron will catch them tomorrow.
    }

    router.push("/?welcome=1");
    router.refresh();
  }

  function toggleSource(id: string) {
    setSources((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  function toggleVertical(id: string) {
    setSelectedVerticalIds((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
    );
  }

  // Which steps this member sees. Until the invite has loaded this is the
  // full list; step is still 0 then (the welcome button waits for
  // profileLoaded), so the list can shrink without stranding anyone.
  const stepKeys = useMemo(() => visibleStepKeys(invite?.prefilledFields ?? []), [invite]);
  const totalSteps = stepKeys.length;
  const safeStep = Math.min(step, totalSteps - 1);
  const stepKey = stepKeys[safeStep];

  // An invite that answered every question (the Per Scholas presets) earns the
  // "most of your setup is done" welcome. One that only set roles and
  // locations (a custom code from Settings) still has family, preferences,
  // sources and focus ahead, so it gets the normal welcome plus the prefill
  // note instead of a promise the flow does not keep.
  const fullInvite = invite && !stepKeys.some((key) => STEP_PREREQS[key]) ? invite : null;

  const stepViews: Record<StepKey, React.ReactNode> = {
    welcome: (
      <div className="text-center space-y-4">
        <h2 className="text-lg font-bold">
          {returningUser
            ? "Welcome back, let's finish up"
            : fullInvite
              ? "Most of your setup is done"
              : "Let's set up your job search"}
        </h2>
        <p className="text-sm text-muted">
          {returningUser
            ? "We saved what you already entered. Click through to review and finish setting up."
            : fullInvite
              ? `Your ${fullInvite.label ? `${fullInvite.label} ` : ""}invite already set your ${describePrefilled(fullInvite.prefilledFields)}. What's left: upload your resume, connect Gmail if you want to, and review. Everything can be changed later in Settings.`
              : "Tell us what you're looking for and we'll find jobs for you every day. Takes about two minutes."}
        </p>
        <p className="text-[10px] text-muted mono uppercase tracking-widest">
          {totalSteps} quick steps
        </p>
        {prefilled && !returningUser && !fullInvite && (
          <p className="text-xs text-accent-purple">
            We pre-filled some preferences from your invite. Feel free to edit.
          </p>
        )}
        <button
          onClick={goNext}
          disabled={!profileLoaded}
          className="px-6 py-2.5 text-sm font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition disabled:opacity-50"
        >
          {!profileLoaded ? "Loading your profile..." : returningUser ? "Pick up where I left off" : "Get Started"}
        </button>
      </div>
    ),

    family: (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-bold">What kind of work are you looking for?</h2>
          <p className="text-[10px] text-muted mt-1">Pick the closest fit. This tunes scraping and tailoring.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {ROLE_FAMILIES.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setRoleFamily(f.id)}
              className={`text-left px-3 py-2.5 text-sm rounded-lg border transition-all ${
                roleFamily === f.id
                  ? "border-accent-purple bg-accent-purple/5 font-medium"
                  : "border-border hover:bg-card text-muted"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
    ),

    // Roles + Locations (merged: both are freeform textareas primed by the
    // role-family placeholder, and users nearly always fill them in the
    // same sitting).
    targeting: (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-bold">What roles, and where?</h2>
          <p className="text-[10px] text-muted mt-1">Comma-separated. Include &ldquo;Remote&rdquo; if open to it.</p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-muted mono uppercase tracking-widest">Target titles</label>
            <textarea
              value={titles}
              onChange={(e) => setTitles(e.target.value)}
              rows={2}
              placeholder={currentFamily.titlePlaceholder}
              className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted mono uppercase tracking-widest">Locations</label>
            <textarea
              value={locations}
              onChange={(e) => setLocations(e.target.value)}
              rows={2}
              placeholder={currentFamily.locationPlaceholder}
              className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
            />
          </div>
        </div>
      </div>
    ),

    // Salary + Daily limit (merged: two short numeric preferences,
    // unnatural to split across screens).
    prefs: (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-bold">Pipeline preferences</h2>
          <p className="text-[10px] text-muted mt-1">We&rsquo;ll skip jobs below the floor and cap the daily pipeline.</p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-muted mono uppercase tracking-widest">Minimum salary</label>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-sm text-muted">$</span>
              <input
                type="number"
                value={salaryFloor || ""}
                onChange={(e) => setSalaryFloor(Number(e.target.value))}
                placeholder="100000"
                step={5000}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white mono focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
              />
            </div>
            <p className="text-[10px] text-muted mt-1">Set to 0 to see everything.</p>
          </div>
          <div>
            <label className="text-[10px] text-muted mono uppercase tracking-widest">Jobs per day</label>
            <div className="flex gap-2 mt-1">
              {DAILY_LIMITS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setDailyLimit(n)}
                  className={`flex-1 py-2.5 text-sm font-semibold rounded-lg border transition-all mono ${
                    dailyLimit === n
                      ? "border-accent-purple bg-accent-purple/5 text-foreground"
                      : "border-border hover:bg-card text-muted"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    ),

    sources: (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-bold">Where should we look?</h2>
          <p className="text-[10px] text-muted mt-1">Select the job boards to scrape.</p>
        </div>
        <div className="space-y-2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggleSource(s.id)}
              className={`w-full text-left px-3 py-2.5 text-sm rounded-lg border transition-all ${
                sources.includes(s.id)
                  ? "border-accent-purple bg-accent-purple/5 text-foreground font-medium"
                  : "border-border hover:bg-card text-muted"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    ),

    // Focus areas (merged: priorities + verticals; both optional boosters
    // that tune match scoring, so it makes sense to co-locate).
    focus: (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-bold">Any focus areas?</h2>
          <p className="text-[11px] text-muted mt-1">
            Optional. Boosts matches for roles in these spaces. Leave blank if unsure.
          </p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-muted mono uppercase tracking-widest">Industries</label>
            <textarea
              value={priorityIndustries}
              onChange={(e) => setPriorityIndustries(e.target.value)}
              rows={2}
              placeholder="Fintech, Consumer, Climate…"
              className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted mono uppercase tracking-widest">Keywords</label>
            <textarea
              value={priorityKeywords}
              onChange={(e) => setPriorityKeywords(e.target.value)}
              rows={2}
              placeholder="B2B SaaS, ML infra, design systems…"
              className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
            />
          </div>
          {verticalPacks.length > 0 && (
            <div>
              <label className="text-[10px] text-muted mono uppercase tracking-widest">Verticals</label>
              <p className="text-[10px] text-muted mt-1 mb-2">
                We&rsquo;ll auto-track the best-known companies in each.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {verticalPacks.map((pack) => {
                  const selected = selectedVerticalIds.includes(pack.id);
                  const count = pack.ats_slugs?.length ?? 0;
                  return (
                    <button
                      key={pack.id}
                      type="button"
                      onClick={() => toggleVertical(pack.id)}
                      className={`text-left px-3 py-2.5 rounded-lg border transition-all ${
                        selected
                          ? "border-accent-purple bg-accent-purple/5"
                          : "border-border hover:bg-card"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-base">{pack.icon}</span>
                        <span className={`text-xs ${selected ? "font-semibold" : "font-medium text-foreground"}`}>
                          {pack.name}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted mono uppercase tracking-widest mt-1.5">
                        {count} {count === 1 ? "co." : "cos."}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    ),

    // Resume (required). 13 of the first 33 users never uploaded one, so
    // the copy says plainly why it matters and what formats work.
    resume: (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-bold">Upload your resume</h2>
          <p className="text-[10px] text-muted mt-1">
            Required. Every job is scored against it, and the tailoring tools rewrite from it. PDF, DOC, DOCX or TXT up to 4 MB, or paste the text.
          </p>
        </div>
        <ResumeUpload
          onUploaded={(len) => { setResumeUploaded(true); setResumeLength(len); }}
          existingLength={resumeLength}
        />
        {resumeUploaded && (
          <p className="text-[10px] text-accent-green mono">
            ✓ Resume saved. {resumeLength.toLocaleString()} characters extracted.
          </p>
        )}
      </div>
    ),

    // Gmail (OPTIONAL). Google caps this OAuth app at about 100 connected
    // accounts, so the step must never stand between a member and the end
    // of onboarding: "Skip for now" sits right under the connect button and
    // the review step finishes without a connection.
    gmail: (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-bold">Connect Gmail (optional)</h2>
          <p className="text-[10px] text-muted mt-1">
            When connected, your pipeline updates itself as interview requests, rejections and offers land in your inbox. Google caps how many accounts this app can connect, so if connecting fails, skip it for now and connect later from Settings.
          </p>
        </div>
        {gmailConnected ? (
          <div className="flex items-center gap-3 px-4 py-3 border border-accent-green/30 bg-accent-green/5 rounded-xl">
            <span className="text-lg">✓</span>
            <p className="text-sm font-semibold">Gmail connected</p>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              type="button"
              onClick={async () => {
                // CRITICAL: save current form state before OAuth full-page
                // redirect wipes all React state. This is the fix for the
                // onboarding-data-loss bug where users lost their profile
                // info and ended up marked as NOT ONBOARDED.
                await saveProgress();
                window.location.href = "/api/gmail/connect?origin=onboarding";
              }}
              className="flex items-center gap-3 px-4 py-3 border border-accent-purple rounded-xl hover:bg-accent-purple/5 transition-colors w-full text-left"
            >
              <span className="text-xl">📬</span>
              <div className="text-left">
                <p className="text-sm font-semibold">Connect Google Account</p>
                <p className="text-[10px] text-muted">Read-only access. OAuth secured by Google.</p>
              </div>
            </button>
            <button
              type="button"
              onClick={goNext}
              className="w-full py-2.5 text-sm font-medium rounded-lg border border-border hover:bg-card transition"
            >
              Skip for now
            </button>
          </div>
        )}
        <p className="text-[10px] text-muted">We never send emails or store message content. Only subject lines are scanned to detect status changes.</p>
      </div>
    ),

    review: (
      <div className="space-y-4">
        <h2 className="text-sm font-bold">Review your setup</h2>
        <div className="bg-card border border-border rounded-xl p-4 space-y-3 text-xs">
          {invite && <Row label="Invite" value={invite.label ?? invite.code} />}
          {stepKeys.includes("family") && <Row label="Role family" value={currentFamily.label} />}
          <Row label="Roles" value={titles || "Not set"} />
          <Row label="Locations" value={locations || "Not set"} />
          <Row label="Min Salary" value={salaryFloor ? `$${salaryFloor.toLocaleString()}` : "Any"} />
          <Row label="Sources" value={sources.map((s) => SOURCES.find((x) => x.id === s)?.label ?? s).join(", ")} />
          <Row label="Daily Limit" value={`${dailyLimit} jobs/day`} />
          <Row label="Resume" value={resumeUploaded ? `✓ Uploaded (${resumeLength.toLocaleString()} chars)` : "⚠ Not uploaded"} />
          <Row label="Gmail" value={gmailConnected ? "✓ Connected" : "Skipped (optional)"} />
        </div>
        <p className="text-[10px] text-muted text-center">
          {invite
            ? "Everything above can be changed in Settings once you're in."
            : "Want to block specific companies? Add them in Settings once you're in."}
        </p>
        {!resumeUploaded && (
          <p className="text-xs text-accent-red">Please upload your resume before continuing.</p>
        )}
        <button
          onClick={handleComplete}
          disabled={loading || !profileLoaded || !titles.trim() || !locations.trim() || !resumeUploaded}
          className="w-full py-2.5 text-sm font-semibold rounded-lg bg-accent-purple text-white hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? "Setting up..." : !profileLoaded ? "Loading your profile..." : "Start My Pipeline"}
        </button>
      </div>
    ),
  };

  const isFirstStep = safeStep === 0;
  const isLastStep = safeStep === totalSteps - 1;
  // On the Gmail step the in-step "Skip for now" button is the way forward
  // until a connection exists; a second Next below it would just duplicate it.
  const hideNext = stepKey === "gmail" && !gmailConnected;

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "var(--background)" }}>
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold tracking-tight">
            Auto<span className="text-accent-purple">pilot</span>
          </h1>
          <div className="flex gap-1 justify-center mt-3">
            {stepKeys.map((key, i) => (
              <div
                key={key}
                className={`h-1 rounded-full transition-all ${
                  i <= safeStep ? "bg-accent-purple w-6" : "bg-border w-4"
                }`}
              />
            ))}
          </div>
          <p className="text-[10px] text-muted mono uppercase tracking-widest mt-2">
            Step {safeStep + 1} of {totalSteps}
          </p>
        </div>

        <div className="animate-fade-up" key={stepKey}>
          {stepViews[stepKey]}
        </div>

        {!isFirstStep && (
          <div className="flex justify-between mt-4">
            <button
              onClick={() => setStep(safeStep - 1)}
              className="text-xs text-muted hover:text-foreground transition"
            >
              Back
            </button>
            {!isLastStep && !hideNext && (
              <button
                onClick={goNext}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition disabled:opacity-40"
              >
                Next
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted uppercase tracking-widest text-[9px]">{label}</span>
      <span className="text-right max-w-[200px] truncate">{value}</span>
    </div>
  );
}
