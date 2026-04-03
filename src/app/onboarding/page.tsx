"use client";

import { useState, useEffect } from "react";
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

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  // Form state
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

  // Load prefilled profile if exists
  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();

      if (profile && profile.target_titles?.length > 0) {
        setTitles(profile.target_titles.join(", "));
        setLocations(profile.target_locations?.join(", ") || "");
        setSalaryFloor(profile.salary_floor || 0);
        setSources(profile.sources || ["linkedin", "builtin"]);
        setDailyLimit(profile.daily_job_limit || 20);
        setExcludedCompanies(profile.excluded_companies?.join(", ") || "");
        setPrefilled(true);
      }
      if (profile?.resume_text?.length > 0) {
        setResumeUploaded(true);
        setResumeLength(profile.resume_text.length);
      }
      if (profile?.gmail_connected) {
        setGmailConnected(true);
      }
      // Check if returning from Gmail OAuth
      const params = new URLSearchParams(window.location.search);
      if (params.get("gmail") === "connected") {
        setGmailConnected(true);
        window.history.replaceState({}, "", "/onboarding");
      }
    }
    loadProfile();
  }, [supabase]);

  async function handleComplete() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const targetTitles = titles.split(",").map((t) => t.trim()).filter(Boolean);
    const targetLocations = locations.split(",").map((l) => l.trim()).filter(Boolean);
    const excluded = excludedCompanies.split(",").map((c) => c.trim()).filter(Boolean);

    await supabase
      .from("profiles")
      .update({
        target_titles: targetTitles,
        target_locations: targetLocations,
        salary_floor: salaryFloor,
        sources,
        daily_job_limit: dailyLimit,
        excluded_companies: excluded,
        onboarded: true,
      })
      .eq("id", user.id);

    router.push("/");
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
      <h2 className="text-lg font-bold">Let's set up your job search</h2>
      <p className="text-sm text-muted">
        Tell us what you're looking for and we'll find jobs for you every day.
      </p>
      {prefilled && (
        <p className="text-xs text-accent-purple">
          We pre-filled some preferences from your invite. Feel free to edit.
        </p>
      )}
      <button
        onClick={() => setStep(1)}
        className="px-6 py-2.5 text-sm font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition"
      >
        Get Started
      </button>
    </div>,

    // Step 1: Roles
    <div key="roles" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">What roles are you looking for?</h2>
        <p className="text-[10px] text-muted mt-1">Comma-separated. e.g. "Product Designer, UX Designer"</p>
      </div>
      <textarea
        value={titles}
        onChange={(e) => setTitles(e.target.value)}
        rows={3}
        placeholder="Product Designer, Senior Product Designer"
        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
      />
    </div>,

    // Step 2: Locations
    <div key="locations" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">Where do you want to work?</h2>
        <p className="text-[10px] text-muted mt-1">Comma-separated. Include "Remote" if open to it.</p>
      </div>
      <textarea
        value={locations}
        onChange={(e) => setLocations(e.target.value)}
        rows={3}
        placeholder="San Francisco, New York, Remote"
        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none"
      />
    </div>,

    // Step 3: Salary
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

    // Step 4: Sources
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

    // Step 5: Daily limit
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

    // Step 6: Excluded companies
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

    // Step 7: Resume (required)
    <div key="resume" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">Upload your resume</h2>
        <p className="text-[10px] text-muted mt-1">
          Required — we use this to score how well each job matches your background and extract keywords for smarter scraping.
        </p>
      </div>
      <ResumeUpload
        onUploaded={(len) => { setResumeUploaded(true); setResumeLength(len); }}
        existingLength={resumeLength}
      />
      {resumeUploaded && (
        <p className="text-[10px] text-accent-green mono">
          ✓ Resume saved — {resumeLength.toLocaleString()} characters extracted
        </p>
      )}
    </div>,

    // Step 8: Gmail connect (required)
    <div key="gmail" className="space-y-4">
      <div>
        <h2 className="text-sm font-bold">Connect Gmail</h2>
        <p className="text-[10px] text-muted mt-1">
          Required. We read your inbox daily to auto-update your pipeline when you get interview requests, rejections, or offers — so you never miss a response.
        </p>
      </div>
      <a
        href="/api/gmail/connect?origin=onboarding"
        className="flex items-center gap-3 px-4 py-3 border border-accent-purple rounded-xl hover:bg-accent-purple/5 transition-colors w-full"
      >
        <span className="text-xl">📬</span>
        <div className="text-left">
          <p className="text-sm font-semibold">Connect Google Account</p>
          <p className="text-[10px] text-muted">Read-only access · OAuth secured by Google</p>
        </div>
      </a>
      <p className="text-[10px] text-muted">We never send emails or store message content — only subject lines are scanned to detect status changes.</p>
    </div>,

    // Step 9: Review
    <div key="review" className="space-y-4">
      <h2 className="text-sm font-bold">Review your setup</h2>
      <div className="bg-card border border-border rounded-xl p-4 space-y-3 text-xs">
        <Row label="Roles" value={titles || "Not set"} />
        <Row label="Locations" value={locations || "Not set"} />
        <Row label="Min Salary" value={salaryFloor ? `$${salaryFloor.toLocaleString()}` : "Any"} />
        <Row label="Sources" value={sources.map((s) => SOURCES.find((x) => x.id === s)?.label).join(", ")} />
        <Row label="Daily Limit" value={`${dailyLimit} jobs/day`} />
        <Row label="Excluded" value={excludedCompanies || "None"} />
        <Row label="Resume" value={resumeUploaded ? `✓ Uploaded (${resumeLength.toLocaleString()} chars)` : "⚠ Not uploaded"} />
        <Row label="Gmail" value={gmailConnected ? "✓ Connected" : "⚠ Not connected"} />
      </div>
      {!resumeUploaded && (
        <p className="text-xs text-accent-red">Please upload your resume before continuing.</p>
      )}
      {!gmailConnected && (
        <p className="text-xs text-accent-red">Please connect Gmail before continuing.</p>
      )}
      <button
        onClick={handleComplete}
        disabled={loading || !titles.trim() || !resumeUploaded || !gmailConnected}
        className="w-full py-2.5 text-sm font-semibold rounded-lg bg-accent-purple text-white hover:opacity-90 transition disabled:opacity-50"
      >
        {loading ? "Setting up..." : "Start My Pipeline"}
      </button>
    </div>,
  ];

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
          {step > 0 && (
            <div className="flex gap-1 justify-center mt-3">
              {steps.slice(1).map((_, i) => (
                <div
                  key={i}
                  className={`h-1 rounded-full transition-all ${
                    i + 1 <= step ? "bg-accent-purple w-6" : "bg-border w-4"
                  }`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="animate-fade-up" key={step}>
          {steps[step]}
        </div>

        {!isFirstStep && !isLastStep && (
          <div className="flex justify-between mt-4">
            <button
              onClick={() => setStep(step - 1)}
              className="text-xs text-muted hover:text-foreground transition"
            >
              Back
            </button>
            <button
              onClick={() => setStep(step + 1)}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition"
            >
              Next
            </button>
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
