"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { ResumeUpload } from "@/components/resume-upload";

const SOURCES = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "builtin", label: "BuiltIn" },
  { id: "hiringcafe", label: "Hiring Cafe" },
  { id: "bandana", label: "Bandana" },
  { id: "welcometothejungle", label: "Welcome to the Jungle" },
];

const DAILY_LIMITS = [10, 20, 30];

type RoleFamily = "design" | "engineering" | "product" | "data" | "marketing" | "ops" | "other";

const ROLE_FAMILIES: { id: RoleFamily; label: string; titlePlaceholder: string; locationPlaceholder: string }[] = [
  { id: "design", label: "Design", titlePlaceholder: "Product Designer, Senior Product Designer, UX Designer", locationPlaceholder: "San Francisco, New York, Remote" },
  { id: "engineering", label: "Engineering", titlePlaceholder: "Software Engineer, Senior Frontend Engineer, Staff Engineer", locationPlaceholder: "San Francisco, New York, Remote" },
  { id: "product", label: "Product", titlePlaceholder: "Product Manager, Senior PM, Group Product Manager", locationPlaceholder: "San Francisco, New York, Remote" },
  { id: "data", label: "Data & ML", titlePlaceholder: "Data Scientist, Analytics Engineer, ML Engineer", locationPlaceholder: "San Francisco, New York, Remote" },
  { id: "marketing", label: "Marketing & Growth", titlePlaceholder: "Growth Marketer, Lifecycle Marketing, Brand Marketing Lead", locationPlaceholder: "New York, Los Angeles, Remote" },
  { id: "ops", label: "Operations", titlePlaceholder: "Business Operations, Program Manager, Chief of Staff", locationPlaceholder: "New York, San Francisco, Remote" },
  { id: "other", label: "Something else", titlePlaceholder: "Your target titles, comma separated", locationPlaceholder: "Cities you want to work in, comma separated" },
];

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [returningUser, setReturningUser] = useState(false);

  // Form state
  const [roleFamily, setRoleFamily] = useState<RoleFamily>("design");
  const [titles, setTitles] = useState("");
  const [locations, setLocations] = useState("");
  const [salaryFloor, setSalaryFloor] = useState(0);
  const [sources, setSources] = useState<string[]>(["linkedin", "builtin"]);
  const [dailyLimit, setDailyLimit] = useState(20);
  const [excludedCompanies, setExcludedCompanies] = useState("");
  const [resumeUploaded, setResumeUploaded] = useState(false);
  const [resumeLength, setResumeLength] = useState(0);
  const [gmailConnected, setGmailConnected] = useState(false);

  const router = useRouter();
  const supabase = createClient();

  // Persist partial onboarding state to the DB. Called on every Next and
  // before the Gmail OAuth redirect. This protects users from losing form
  // state during OAuth full-page redirects, tab closes, or browser crashes.
  //
  // Critical: never sets `onboarded: true` — that only happens in
  // handleComplete. The partial save just preserves what the user has
  // entered so loadProfile() can rehydrate them on return.
  async function saveProgress() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const targetTitles = titles.split(",").map((t) => t.trim()).filter(Boolean);
    const targetLocations = locations.split(",").map((l) => l.trim()).filter(Boolean);
    const excluded = excludedCompanies.split(",").map((c) => c.trim()).filter(Boolean);

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

    try {
      await supabase.from("profiles").update(update).eq("id", user.id);
    } catch {
      // Non-fatal — if the save fails, the next Next will retry.
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

        const { data: profile } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .single();

        // Rehydrate form state from any previously-saved fields. We check
        // each field independently so a returning user who filled out only
        // roles (not locations) gets their roles back. This is what
        // prevents the Gmail-OAuth data wipe — saveProgress() persists
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

          // Any persisted field counts as returning progress — including
          // invite-prefilled rows (target_titles) and mid-flow partial
          // saves (role_family). The actual step jump to the review
          // screen happens below when ?gmail=connected is present.
          const hasAnyProgress =
            profile.target_titles?.length > 0 ||
            profile.target_locations?.length > 0 ||
            profile.role_family;
          if (hasAnyProgress) {
            setPrefilled(true);
            // Distinguish invite-prefilled (only target_titles) from a
            // returning partial onboarder (has role_family too).
            if (profile.role_family && !profile.onboarded) {
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
        const params = new URLSearchParams(window.location.search);
        if (params.get("gmail") === "connected") {
          setGmailConnected(true);
          setStep(STEPS_COUNT - 1);
          window.history.replaceState({}, "", "/onboarding");
        }
      } finally {
        // Always unblock the button — the handleComplete guard (checking
        // non-empty titles/locations) is the real data safety. profileLoaded
        // only prevents a click during the brief fetch window; a fetch error
        // should never permanently disable the button.
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

    // Refuse to overwrite with empty values — prevents the Gmail-OAuth return
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
        onboarded: true,
      })
      .eq("id", user.id);

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

  const steps = [
    // Step 0: Welcome
    <div key="welcome" className="text-center space-y-4">
      <h2 className="text-lg font-bold">
        {returningUser ? "Welcome back — let's finish up" : "Let's set up your job search"}
      </h2>
      <p className="text-sm text-muted">
        {returningUser
          ? "We saved what you already entered. Click through to review and finish setting up."
          : "Tell us what you're looking for and we'll find jobs for you every day. Takes about two minutes."}
      </p>
      <p className="text-[10px] text-muted mono uppercase tracking-widest">9 quick steps</p>
      {prefilled && !returningUser && (
        <p className="text-xs text-accent-purple">
          We pre-filled some preferences from your invite. Feel free to edit.
        </p>
      )}
      <button
        onClick={goNext}
        className="px-6 py-2.5 text-sm font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition"
      >
        {returningUser ? "Pick up where I left off" : "Get Started"}
      </button>
    </div>,

    // Step 1: Role family
    <div key="family" className="space-y-4">
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
    </div>,

    // Step 2: Roles
    <div key="roles" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">What roles are you looking for?</h2>
        <p className="text-[10px] text-muted mt-1">Comma-separated. You can list 2 to 5 titles.</p>
      </div>
      <textarea
        value={titles}
        onChange={(e) => setTitles(e.target.value)}
        rows={3}
        placeholder={currentFamily.titlePlaceholder}
        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
      />
    </div>,

    // Step 3: Locations
    <div key="locations" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">Where do you want to work?</h2>
        <p className="text-[10px] text-muted mt-1">Comma-separated. Include "Remote" if open to it.</p>
      </div>
      <textarea
        value={locations}
        onChange={(e) => setLocations(e.target.value)}
        rows={3}
        placeholder={currentFamily.locationPlaceholder}
        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
      />
    </div>,

    // Step 4: Salary
    <div key="salary" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">Minimum salary?</h2>
        <p className="text-[10px] text-muted mt-1">We'll skip jobs below this. Set to 0 to see everything.</p>
      </div>
      <div className="flex items-center gap-3">
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
    </div>,

    // Step 5: Sources
    <div key="sources" className="space-y-4">
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
    </div>,

    // Step 6: Daily limit
    <div key="limit" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">How many new jobs per day?</h2>
        <p className="text-[10px] text-muted mt-1">We'll cap your daily pipeline at this number.</p>
      </div>
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
    </div>,

    // Step 7: Excluded companies
    <div key="excluded" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">Any companies to skip?</h2>
        <p className="text-[10px] text-muted mt-1">Optional. Comma-separated.</p>
      </div>
      <textarea
        value={excludedCompanies}
        onChange={(e) => setExcludedCompanies(e.target.value)}
        rows={3}
        placeholder="Company X, Company Y"
        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
      />
    </div>,

    // Step 8: Resume (required)
    <div key="resume" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">Upload your resume</h2>
        <p className="text-[10px] text-muted mt-1">
          Required. We use this to score how well each job matches your background and extract keywords for smarter scraping.
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
    </div>,

    // Step 9: Gmail (OPTIONAL)
    <div key="gmail" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">Connect Gmail (optional)</h2>
        <p className="text-[10px] text-muted mt-1">
          We read your inbox daily to auto-update your pipeline when you get interview requests, rejections, or offers. You can skip this and connect later in Settings.
        </p>
      </div>
      {gmailConnected ? (
        <div className="flex items-center gap-3 px-4 py-3 border border-accent-green/30 bg-accent-green/5 rounded-xl">
          <span className="text-lg">✓</span>
          <p className="text-sm font-semibold">Gmail connected</p>
        </div>
      ) : (
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
      )}
      <p className="text-[10px] text-muted">We never send emails or store message content. Only subject lines are scanned to detect status changes.</p>
    </div>,

    // Step 10: Review
    <div key="review" className="space-y-4">
      <h2 className="text-sm font-bold">Review your setup</h2>
      <div className="bg-card border border-border rounded-xl p-4 space-y-3 text-xs">
        <Row label="Role family" value={currentFamily.label} />
        <Row label="Roles" value={titles || "Not set"} />
        <Row label="Locations" value={locations || "Not set"} />
        <Row label="Min Salary" value={salaryFloor ? `$${salaryFloor.toLocaleString()}` : "Any"} />
        <Row label="Sources" value={sources.map((s) => SOURCES.find((x) => x.id === s)?.label).join(", ")} />
        <Row label="Daily Limit" value={`${dailyLimit} jobs/day`} />
        <Row label="Excluded" value={excludedCompanies || "None"} />
        <Row label="Resume" value={resumeUploaded ? `✓ Uploaded (${resumeLength.toLocaleString()} chars)` : "⚠ Not uploaded"} />
        <Row label="Gmail" value={gmailConnected ? "✓ Connected" : "Skipped (optional)"} />
      </div>
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
    </div>,
  ];

  const STEPS_COUNT = steps.length;
  const totalSteps = steps.length;
  const isFirstStep = step === 0;
  const isLastStep = step === totalSteps - 1;

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "var(--background)" }}>
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold tracking-tight">
            Auto<span className="text-accent-purple">pilot</span>
          </h1>
          <div className="flex gap-1 justify-center mt-3">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`h-1 rounded-full transition-all ${
                  i <= step ? "bg-accent-purple w-6" : "bg-border w-4"
                }`}
              />
            ))}
          </div>
          <p className="text-[10px] text-muted mono uppercase tracking-widest mt-2">
            Step {step + 1} of {totalSteps}
          </p>
        </div>

        <div className="animate-fade-up" key={step}>
          {steps[step]}
        </div>

        {!isFirstStep && (
          <div className="flex justify-between mt-4">
            <button
              onClick={() => setStep(step - 1)}
              className="text-xs text-muted hover:text-foreground transition"
            >
              Back
            </button>
            {!isLastStep && (
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
