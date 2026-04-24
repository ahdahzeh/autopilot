"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import type { Job, DismissReason } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { showToast } from "@/components/toast";

type FeedbackType =
  | "wrong_seniority"
  | "wrong_industry"
  | "wrong_location"
  | "spam"
  | "not_a_fit";

const FEEDBACK_OPTIONS: { value: FeedbackType; label: string }[] = [
  { value: "wrong_seniority", label: "Wrong seniority" },
  { value: "wrong_industry", label: "Wrong industry" },
  { value: "wrong_location", label: "Wrong location" },
  { value: "spam", label: "Looks like spam" },
  { value: "not_a_fit", label: "Just not for me" },
];

// Map feedback type → the existing DismissReason vocabulary so we can reuse
// /api/jobs/[id]/dismiss (which updates jobs.outcome='dismissed' + status='Dismissed').
function feedbackToDismissReason(fb: FeedbackType): DismissReason {
  if (fb === "spam") return "scam";
  return "not_interested";
}

type Tab = "overview" | "match" | "bullets" | "cover" | "strategy" | "prep";

type MatchData = {
  score: number;
  headline: string;
  strengths: string[];
  gaps: string[];
  verdict: "strong" | "decent" | "stretch" | "mismatch";
};

type BulletItem = { original: string; rewritten: string; why: string };
type BulletsData = { bullets: BulletItem[] };

type CoverData = { paragraphs: string[]; subject_line: string };

type StrategyData = {
  level_read: string;
  positioning: {
    lead_with_role: string;
    downplay_role: string;
    title_bridge: string;
    story_arc: string;
  };
  salary_lens: {
    assumption: string;
    band_estimate: string;
    negotiation_angle: string;
  };
  risks: { risk: string; mitigation: string }[];
};

type PrepQuestion = { q: string; why: string; answer_seed: string };
type AskQuestion = { q: string; signals?: string };
type PrepData = { questions: PrepQuestion[]; questions_to_ask_them: AskQuestion[] };

type Block = "match" | "bullets" | "cover" | "strategy" | "prep";

type BlockState<T> = {
  status: "idle" | "running" | "done" | "error";
  data: T | null;
  error: string | null;
};

const initialBlock = <T,>(): BlockState<T> => ({
  status: "idle",
  data: null,
  error: null,
});

export function JobDetailModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  // Prefill from the scraper-stored description so users only have to hit
  // Generate. Older jobs without a stored description fall back to empty.
  const [jobDescription, setJobDescription] = useState(job.description || "");
  const [running, setRunning] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const [match, setMatch] = useState<BlockState<MatchData>>(initialBlock<MatchData>());
  const [bullets, setBullets] = useState<BlockState<BulletsData>>(initialBlock<BulletsData>());
  const [cover, setCover] = useState<BlockState<CoverData>>(initialBlock<CoverData>());
  const [strategy, setStrategy] = useState<BlockState<StrategyData>>(initialBlock<StrategyData>());
  const [prep, setPrep] = useState<BlockState<PrepData>>(initialBlock<PrepData>());

  const abortRef = useRef<AbortController | null>(null);
  const autoCoverAbortRef = useRef<AbortController | null>(null);
  const autoCoverFiredRef = useRef<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [autoCoverDrafting, setAutoCoverDrafting] = useState(false);

  // Only render the portal after mount so SSR doesn't try to reach for
  // document.body. Also lock body scroll while open.
  useEffect(() => {
    setMounted(true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      autoCoverAbortRef.current?.abort();
    };
  }, []);

  // If the modal is reused for a different job, refresh the prefilled JD.
  useEffect(() => {
    setJobDescription(job.description || "");
  }, [job.id, job.description]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-draft the cover letter in the background when the modal opens, as
  // long as we have a JD and haven't already drafted one. Only fires the
  // cover block to preserve the user's 40/day rate limit — other tabs stay
  // on-demand. Guarded by a ref so Strict Mode's double-effect (and any job
  // id shuffle) doesn't double-fire.
  useEffect(() => {
    if (!job.description || job.description.trim().length < 50) return;
    if (cover.status !== "idle") return;
    if (autoCoverFiredRef.current === job.id) return;
    autoCoverFiredRef.current = job.id;

    const ctrl = new AbortController();
    autoCoverAbortRef.current = ctrl;
    setAutoCoverDrafting(true);
    setCover({ status: "running", data: null, error: null });

    (async () => {
      try {
        const res = await fetch("/api/tailor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            jobDescription: job.description,
            role: job.role,
            company: job.company || job.name,
            jobId: job.id,
            blocks: ["cover"],
          }),
        });
        if (!res.ok || !res.body) {
          setCover({ status: "error", data: null, error: "Auto-draft failed." });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split("\n\n");
          buffer = messages.pop() ?? "";
          for (const raw of messages) {
            if (!raw.trim() || raw.trimStart().startsWith(":")) continue;
            const lines = raw.split("\n");
            let event = "message";
            let dataLine = "";
            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
            }
            if (!dataLine) continue;
            let payload: any;
            try { payload = JSON.parse(dataLine); } catch { continue; }
            if (payload?.block !== "cover") continue;
            if (event === "done") setCover({ status: "done", data: payload.data as CoverData, error: null });
            if (event === "error") setCover({ status: "error", data: null, error: payload.error || "Failed" });
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        setCover((s) => s.status === "running"
          ? { status: "error", data: null, error: "Auto-draft failed." }
          : s);
      } finally {
        setAutoCoverDrafting(false);
      }
    })();

    return () => {
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  async function submitFeedback(type: FeedbackType) {
    if (feedbackSubmitting) return;
    setFeedbackSubmitting(true);
    try {
      const supabase = createClient();
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (userId) {
        await supabase.from("job_feedback").insert({
          user_id: userId,
          job_id: job.id,
          feedback_type: type,
          company: job.company || job.name || null,
          role: job.role || null,
        });
      }
      // Mirror the dismiss flow so the jobs row gets outcome='dismissed' +
      // status='Dismissed' via the same server handler the dashboard uses.
      await fetch(`/api/jobs/${job.id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: feedbackToDismissReason(type) }),
      }).catch(() => {});
    } catch (err) {
      console.error("[feedback] submit failed", err);
    } finally {
      setFeedbackSubmitting(false);
      setFeedbackOpen(false);
      showToast({
        id: `feedback-${job.id}-${Date.now()}`,
        message: "Got it — we'll avoid similar roles on your next scrape.",
      });
      onClose();
    }
  }

  async function copyApplicationBundle() {
    const coverText = cover.status === "done" && cover.data
      ? cover.data.paragraphs.join("\n\n")
      : "— Cover letter not generated yet —";

    let bulletsText: string;
    if (bullets.status === "done" && bullets.data && bullets.data.bullets.length > 0) {
      bulletsText = bullets.data.bullets
        .slice(0, 3)
        .map((b) => `• ${b.rewritten}`)
        .join("\n");
    } else {
      bulletsText = "— Tailored bullets not generated yet —";
    }

    const bundle =
`[Cover Letter]
${coverText}

[Top 3 Tailored Bullets]
${bulletsText}

[Quick Facts]
Role: ${job.role || "-"}
Company: ${job.company || job.name || "-"}
Apply: ${job.applyLink || "-"}`;

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(bundle);
      showToast({
        id: `copy-${job.id}-${Date.now()}`,
        message: "Copied — paste into the ATS form.",
      });
    } catch {
      showToast({
        id: `copy-err-${job.id}-${Date.now()}`,
        message: "Couldn't copy — clipboard blocked by this browser.",
      });
    }
  }

  const setBlockStarting = (block: Block) => {
    const update = { status: "running" as const, data: null, error: null };
    if (block === "match") setMatch(update);
    if (block === "bullets") setBullets(update);
    if (block === "cover") setCover(update);
    if (block === "strategy") setStrategy(update);
    if (block === "prep") setPrep(update);
  };

  const setBlockDone = (block: Block, data: unknown) => {
    if (block === "match") setMatch({ status: "done", data: data as MatchData, error: null });
    if (block === "bullets") setBullets({ status: "done", data: data as BulletsData, error: null });
    if (block === "cover") setCover({ status: "done", data: data as CoverData, error: null });
    if (block === "strategy") setStrategy({ status: "done", data: data as StrategyData, error: null });
    if (block === "prep") setPrep({ status: "done", data: data as PrepData, error: null });
  };

  const setBlockError = (block: Block, error: string) => {
    const update = { status: "error" as const, data: null, error };
    if (block === "match") setMatch(update);
    if (block === "bullets") setBullets(update);
    if (block === "cover") setCover(update);
    if (block === "strategy") setStrategy(update);
    if (block === "prep") setPrep(update);
  };

  async function generate() {
    if (jobDescription.trim().length < 50) return;
    // Cancel any in-flight auto-cover so its late "done" event can't clobber
    // the fresh run the user just kicked off.
    autoCoverAbortRef.current?.abort();
    setAutoCoverDrafting(false);
    setRunning(true);
    setGeneralError(null);
    // Optimistically set every block to "running" the moment the user clicks.
    // The server will later confirm with its own "start" events, but this way
    // the user immediately sees the loading dots even if the SSE stream is
    // slow to first-byte (cold start, edge buffering, etc.). Without this the
    // Match tab sits on the Empty state until the first event arrives, which
    // looks like nothing happened.
    setMatch({ status: "running", data: null, error: null });
    setBullets({ status: "running", data: null, error: null });
    setCover({ status: "running", data: null, error: null });
    setStrategy({ status: "running", data: null, error: null });
    setPrep({ status: "running", data: null, error: null });
    setTab("match");

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      console.log("[tailor] POST /api/tailor", { role: job.role, jobId: job.id });
      const res = await fetch("/api/tailor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          jobDescription,
          role: job.role,
          company: job.company || job.name,
          jobId: job.id,
        }),
      });
      console.log("[tailor] response", res.status, res.headers.get("content-type"));

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let parsed: { error?: string } | null = null;
        try { parsed = JSON.parse(text); } catch {}
        const msg = parsed?.error || `Tailoring failed (${res.status}). Try again.`;
        setGeneralError(msg);
        // Surface the failure on every block so the user isn't stuck on the
        // running spinner forever.
        setMatch({ status: "error", data: null, error: msg });
        setBullets({ status: "error", data: null, error: msg });
        setCover({ status: "error", data: null, error: msg });
        setStrategy({ status: "error", data: null, error: msg });
        setPrep({ status: "error", data: null, error: msg });
        setRunning(false);
        return;
      }

      // Parse SSE events as they arrive.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE messages are delimited by a blank line.
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";
        for (const raw of messages) {
          if (!raw.trim()) continue;
          // Skip comment frames (lines starting with ":") used by the server
          // to flush proxy buffers.
          if (raw.trimStart().startsWith(":")) continue;
          const lines = raw.split("\n");
          let event = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          let payload: any;
          try { payload = JSON.parse(dataLine); } catch { continue; }
          console.log("[tailor] event", event, payload);
          handleEvent(event, payload);
        }
      }
      console.log("[tailor] stream closed");
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      console.error("[tailor] fetch failed", err);
      const msg = err?.message ? `Connection lost: ${err.message}` : "Connection lost. Try again.";
      setGeneralError(msg);
      // Mirror the failure into any block still spinning.
      const failIfRunning = <T,>(s: BlockState<T>): BlockState<T> =>
        s.status === "running" ? { status: "error", data: null, error: msg } : s;
      setMatch((s) => failIfRunning(s));
      setBullets((s) => failIfRunning(s));
      setCover((s) => failIfRunning(s));
      setStrategy((s) => failIfRunning(s));
      setPrep((s) => failIfRunning(s));
    } finally {
      setRunning(false);
    }
  }

  function handleEvent(event: string, payload: any) {
    if (event === "start" && payload?.block) setBlockStarting(payload.block as Block);
    if (event === "done" && payload?.block) setBlockDone(payload.block as Block, payload.data);
    if (event === "error" && payload?.block) setBlockError(payload.block as Block, payload.error || "Failed");
  }

  async function saveStory(bullet_text: string, original_resume_text: string | null) {
    try {
      await fetch("/api/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bullet_text,
          original_resume_text,
          source_job_id: job.id,
          tags: [job.role, job.company || job.name].filter(Boolean),
        }),
      });
    } catch {
      // Silent — saving is non-critical, user can retry from the story bank.
    }
  }

  const hasResults =
    match.status !== "idle" ||
    bullets.status !== "idle" ||
    cover.status !== "idle" ||
    strategy.status !== "idle" ||
    prep.status !== "idle";

  const TABS: { id: Tab; label: string; status?: BlockState<unknown>["status"]; subtle?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "match", label: "Match", status: match.status },
    { id: "bullets", label: "Bullets", status: bullets.status },
    { id: "cover", label: "Cover", status: cover.status, subtle: autoCoverDrafting ? "Drafting cover letter…" : undefined },
    { id: "strategy", label: "Strategy", status: strategy.status },
    { id: "prep", label: "Interview", status: prep.status },
  ];

  if (!mounted) return null;

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-2 sm:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        className="relative bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-bold truncate">{job.company || job.name}</h2>
            <p className="text-xs text-muted truncate">{job.role}</p>
            <div className="flex items-center gap-2 mt-1 text-[10px] text-muted">
              {job.location && <span className="mono">{job.location}</span>}
              {job.salaryRange && <span className="mono">· {job.salaryRange}</span>}
              {job.source && <span>· {job.source}</span>}
            </div>
          </div>
          <div className="flex items-start gap-2 shrink-0">
            <div className="relative">
              <button
                onClick={() => setFeedbackOpen((v) => !v)}
                disabled={feedbackSubmitting}
                className="px-2 py-1 rounded-lg text-[11px] font-medium bg-orange-light text-orange border border-orange/20 hover:bg-orange/10 transition disabled:opacity-50"
                aria-label="Report not a fit"
              >
                Not a fit
              </button>
              {feedbackOpen && (
                <>
                  <div
                    className="fixed inset-0 z-[60]"
                    onClick={() => setFeedbackOpen(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 bg-white border border-border rounded-lg shadow-lg py-1 z-[70] min-w-[180px]">
                    <p className="px-3 py-1 text-[9px] uppercase tracking-widest text-muted font-medium">
                      Why not?
                    </p>
                    {FEEDBACK_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => submitFeedback(opt.value)}
                        disabled={feedbackSubmitting}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors disabled:opacity-50"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-muted hover:text-foreground text-2xl leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* Why this fits — Haiku scorer output */}
        {(job.scoreReasoning || job.matchedSkills.length > 0 || job.concerns.length > 0) && (
          <div className="px-4 sm:px-5 py-3 border-b border-border bg-bg2">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-2">Why this fits</p>
            {job.scoreReasoning && (
              <div className="border border-border rounded-lg bg-white px-3 py-2 mb-2">
                <p className="text-xs leading-relaxed">{job.scoreReasoning}</p>
              </div>
            )}
            {(job.matchedSkills.length > 0 || job.concerns.length > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {job.matchedSkills.map((skill, i) => (
                  <span
                    key={`skill-${i}`}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-light text-accent-green border border-accent-green/20"
                  >
                    {skill}
                  </span>
                ))}
                {job.concerns.map((concern, i) => (
                  <span
                    key={`concern-${i}`}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-light text-orange border border-orange/20"
                  >
                    {concern}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 px-2 sm:px-4 border-b border-border overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-3 py-2.5 text-[11px] font-medium whitespace-nowrap transition-colors ${
                tab === t.id ? "text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {t.label}
              {t.status === "running" && (
                <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent-purple animate-pulse" />
              )}
              {t.status === "done" && (
                <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent-green" />
              )}
              {t.status === "error" && (
                <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent-red" />
              )}
              {tab === t.id && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute inset-x-0 -bottom-px h-0.5 bg-accent-purple"
                />
              )}
            </button>
          ))}
        </div>

        {autoCoverDrafting && (
          <div className="px-4 sm:px-5 py-1.5 border-b border-border bg-bg2">
            <p className="text-[10px] text-muted mono uppercase tracking-widest">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-purple animate-pulse mr-1.5 align-middle" />
              Drafting cover letter…
            </p>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
            >
              {tab === "overview" && (
                <OverviewTab
                  job={job}
                  jobDescription={jobDescription}
                  setJobDescription={setJobDescription}
                  generate={generate}
                  running={running}
                  hasResults={hasResults}
                  generalError={generalError}
                />
              )}
              {tab === "match" && <MatchTab state={match} />}
              {tab === "bullets" && <BulletsTab state={bullets} onSave={saveStory} />}
              {tab === "cover" && <CoverTab state={cover} />}
              {tab === "strategy" && <StrategyTab state={strategy} />}
              {tab === "prep" && <PrepTab state={prep} />}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer — ATS bundle + apply shortcut. Stays compact on mobile. */}
        <div className="flex items-center gap-2 p-3 border-t border-border bg-bg2">
          <button
            onClick={copyApplicationBundle}
            className="flex-1 py-2 text-[11px] font-medium rounded-lg border border-border bg-white hover:bg-background transition truncate"
          >
            Copy application bundle
          </button>
          {job.applyLink && (
            <a
              href={job.applyLink}
              target="_blank"
              rel="noopener noreferrer"
              className="py-2 px-3 text-[11px] font-semibold rounded-lg bg-accent-purple text-white hover:opacity-90 transition shrink-0"
            >
              Apply ↗
            </a>
          )}
        </div>
      </motion.div>
    </div>
  );

  return createPortal(modal, document.body);
}

// ---- Tabs ---------------------------------------------------------------

function OverviewTab({
  job,
  jobDescription,
  setJobDescription,
  generate,
  running,
  hasResults,
  generalError,
}: {
  job: Job;
  jobDescription: string;
  setJobDescription: (v: string) => void;
  generate: () => void;
  running: boolean;
  hasResults: boolean;
  generalError: string | null;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 text-xs">
        <Field label="Status" value={job.status || "-"} />
        <Field label="Priority" value={job.priority || "-"} />
        <Field label="Match (heuristic)" value={job.matchScore !== null ? `${job.matchScore}/10` : "-"} mono />
        <Field label="Tailor Score" value={job.tailorScore !== null ? `${job.tailorScore}/100` : "-"} mono />
        <Field label="Source" value={job.source || "-"} />
        <Field label="Date Found" value={job.dateFound || "-"} mono />
        <Field label="Date Applied" value={job.dateApplied || "-"} mono />
        <Field label="Salary" value={job.salaryRange || "-"} mono />
      </div>
      {job.tailorReasoning && (
        <p className="text-xs text-muted italic border-l-2 border-accent-purple/40 pl-3">
          {job.tailorReasoning}
        </p>
      )}

      {job.applyLink && (
        <a
          href={job.applyLink}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center py-2 border border-border rounded-lg text-xs font-medium hover:bg-background transition"
        >
          View Job Listing ↗
        </a>
      )}

      <div className="border-t border-border pt-4">
        <label className="text-[10px] uppercase tracking-widest text-muted font-medium block mb-2 flex items-center justify-between">
          <span>Job Description</span>
          {jobDescription.trim().length >= 50 && (
            <span className="text-accent-green normal-case tracking-normal text-[10px]">
              ✓ prefilled
            </span>
          )}
        </label>
        <textarea
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          rows={8}
          placeholder="Paste the full job description here..."
          className="w-full px-3 py-2 text-xs border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none font-mono"
        />
        {generalError && <p className="text-xs text-accent-red mt-2">{generalError}</p>}
        <button
          onClick={generate}
          disabled={running || jobDescription.trim().length < 50}
          className="mt-3 w-full py-2.5 text-xs font-semibold rounded-lg bg-accent-purple text-white hover:opacity-90 transition disabled:opacity-50"
        >
          {running ? "Generating intelligence…" : hasResults ? "Regenerate" : "Tailor for this job"}
        </button>
        <p className="text-[10px] text-muted mt-2">
          Runs 5 passes: match score, bullets, cover letter, level strategy, interview prep.
        </p>
      </div>
    </div>
  );
}

function MatchTab({ state }: { state: BlockState<MatchData> }) {
  if (state.status === "idle") return <Empty hint="Tailor first to see your match score." />;
  if (state.status === "running") return <Loading label="Scoring match…" />;
  if (state.status === "error") return <ErrorBox message={state.error} />;
  const d = state.data!;
  const verdictColor =
    d.verdict === "strong" ? "text-accent-green" :
    d.verdict === "decent" ? "text-accent-purple" :
    d.verdict === "stretch" ? "text-amber-600" : "text-accent-red";
  return (
    <div className="space-y-5">
      <div className="text-center py-4">
        <div className="mono text-5xl font-bold tracking-tight">{d.score}<span className="text-2xl text-muted">/100</span></div>
        <div className={`text-[10px] uppercase tracking-widest mt-1 font-semibold ${verdictColor}`}>{d.verdict}</div>
        <p className="text-sm mt-3 px-4">{d.headline}</p>
      </div>
      <Section title="Strengths">
        <ul className="space-y-1.5">
          {d.strengths.map((s, i) => (
            <li key={i} className="flex gap-2 text-xs"><span className="text-accent-green mt-0.5">+</span><span>{s}</span></li>
          ))}
        </ul>
      </Section>
      {d.gaps.length > 0 && (
        <Section title="Gaps">
          <ul className="space-y-1.5">
            {d.gaps.map((g, i) => (
              <li key={i} className="flex gap-2 text-xs"><span className="text-amber-600 mt-0.5">!</span><span>{g}</span></li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function BulletsTab({
  state,
  onSave,
}: {
  state: BlockState<BulletsData>;
  onSave: (text: string, original: string | null) => void;
}) {
  const [saved, setSaved] = useState<Set<number>>(new Set());
  if (state.status === "idle") return <Empty hint="Tailor first to see rewritten bullets." />;
  if (state.status === "running") return <Loading label="Rewriting bullets…" />;
  if (state.status === "error") return <ErrorBox message={state.error} />;
  const d = state.data!;
  function copy() {
    navigator.clipboard.writeText(d.bullets.map((b) => `• ${b.rewritten}`).join("\n"));
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-widest text-muted font-medium">5 Tailored Bullets</p>
        <button onClick={copy} className="text-[10px] text-accent-purple hover:opacity-70">Copy all</button>
      </div>
      {d.bullets.map((b, i) => (
        <div key={i} className="border border-border rounded-lg p-3 bg-white space-y-2">
          <p className="text-xs leading-relaxed">{b.rewritten}</p>
          <p className="text-[10px] text-muted italic">{b.why}</p>
          <details className="text-[10px] text-muted">
            <summary className="cursor-pointer hover:text-foreground">Original</summary>
            <p className="mt-1 italic">{b.original}</p>
          </details>
          <button
            onClick={() => {
              onSave(b.rewritten, b.original);
              setSaved((prev) => new Set(prev).add(i));
            }}
            disabled={saved.has(i)}
            className="text-[10px] text-accent-purple hover:opacity-70 disabled:opacity-50"
          >
            {saved.has(i) ? "✓ Saved to story bank" : "+ Save to story bank"}
          </button>
        </div>
      ))}
    </div>
  );
}

function CoverTab({ state }: { state: BlockState<CoverData> }) {
  if (state.status === "idle") return <Empty hint="Tailor first to see your cover letter." />;
  if (state.status === "running") return <Loading label="Drafting cover letter…" />;
  if (state.status === "error") return <ErrorBox message={state.error} />;
  const d = state.data!;
  function copy() {
    navigator.clipboard.writeText(d.paragraphs.join("\n\n"));
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-widest text-muted font-medium">
          Subject: <span className="text-foreground normal-case tracking-normal">{d.subject_line}</span>
        </p>
        <button onClick={copy} className="text-[10px] text-accent-purple hover:opacity-70">Copy</button>
      </div>
      <div className="border border-border rounded-lg p-4 bg-white space-y-3">
        {d.paragraphs.map((p, i) => (
          <p key={i} className="text-xs leading-relaxed">{p}</p>
        ))}
      </div>
    </div>
  );
}

function StrategyTab({ state }: { state: BlockState<StrategyData> }) {
  if (state.status === "idle") return <Empty hint="Tailor first to see your positioning strategy." />;
  if (state.status === "running") return <Loading label="Building strategy…" />;
  if (state.status === "error") return <ErrorBox message={state.error} />;
  const d = state.data!;
  const pos = d.positioning;
  const sal = d.salary_lens;
  const positioningItems = pos && typeof pos === "object" && !Array.isArray(pos)
    ? [
        pos.lead_with_role && { label: "Lead with", text: pos.lead_with_role },
        pos.downplay_role && { label: "Downplay", text: pos.downplay_role },
        pos.title_bridge && { label: "Title bridge", text: pos.title_bridge },
        pos.story_arc && { label: "Story arc", text: pos.story_arc },
      ].filter(Boolean) as { label: string; text: string }[]
    : (Array.isArray(pos) ? pos.map((p) => ({ label: "", text: String(p) })) : []);
  return (
    <div className="space-y-4">
      <Section title="Level Read">
        <p className="text-xs leading-relaxed">{d.level_read}</p>
      </Section>
      <Section title="Positioning Tactics">
        <ul className="space-y-2">
          {positioningItems.map((p, i) => (
            <li key={i} className="flex gap-2 text-xs">
              <span className="text-accent-purple mt-0.5">→</span>
              <span>
                {p.label ? <span className="font-semibold">{p.label}: </span> : null}
                <span>{p.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Salary Lens">
        {sal && typeof sal === "object" ? (
          <div className="space-y-1.5 text-xs leading-relaxed">
            {sal.band_estimate && <p><span className="font-semibold">Band:</span> {sal.band_estimate}</p>}
            {sal.assumption && <p><span className="font-semibold">Assumption:</span> {sal.assumption}</p>}
            {sal.negotiation_angle && <p><span className="font-semibold">Leverage:</span> {sal.negotiation_angle}</p>}
          </div>
        ) : (
          <p className="text-xs leading-relaxed">{String(sal ?? "")}</p>
        )}
      </Section>
      {d.risks?.length > 0 && (
        <Section title="Risks">
          <ul className="space-y-2">
            {d.risks.map((r, i) => {
              const risk = typeof r === "string" ? r : r?.risk;
              const mitigation = typeof r === "string" ? null : r?.mitigation;
              return (
                <li key={i} className="flex gap-2 text-xs">
                  <span className="text-amber-600 mt-0.5">⚠</span>
                  <span>
                    <span>{risk}</span>
                    {mitigation ? <span className="block text-[10px] text-muted italic mt-0.5">Mitigation: {mitigation}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </div>
  );
}

function PrepTab({ state }: { state: BlockState<PrepData> }) {
  if (state.status === "idle") return <Empty hint="Tailor first to see interview prep." />;
  if (state.status === "running") return <Loading label="Preparing interview…" />;
  if (state.status === "error") return <ErrorBox message={state.error} />;
  const d = state.data!;
  return (
    <div className="space-y-4">
      <Section title="Likely Questions">
        <div className="space-y-3">
          {d.questions.map((q, i) => (
            <div key={i} className="border border-border rounded-lg p-3 bg-white">
              <p className="text-xs font-semibold">{q.q}</p>
              <p className="text-[10px] text-muted mt-1 italic">{q.why}</p>
              <p className="text-xs leading-relaxed mt-2">{q.answer_seed}</p>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Ask Them">
        <ul className="space-y-2">
          {d.questions_to_ask_them.map((item, i) => {
            const text = typeof item === "string" ? item : item?.q;
            const signals = typeof item === "string" ? null : item?.signals;
            return (
              <li key={i} className="flex gap-2 text-xs">
                <span className="text-accent-purple mt-0.5">?</span>
                <span>
                  <span>{text}</span>
                  {signals ? <span className="block text-[10px] text-muted italic mt-0.5">{signals}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

// ---- Helpers ------------------------------------------------------------

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-widest text-muted">{label}</p>
      <p className={`mt-0.5 ${mono ? "mono" : ""}`}>{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-2">{title}</p>
      {children}
    </div>
  );
}

function Empty({ hint }: { hint: string }) {
  return <p className="text-xs text-muted text-center py-12">{hint}</p>;
}

function Loading({ label }: { label: string }) {
  return (
    <div className="text-center py-12 space-y-3">
      <div className="inline-flex gap-1">
        <span className="w-2 h-2 rounded-full bg-accent-purple animate-pulse" />
        <span className="w-2 h-2 rounded-full bg-accent-purple animate-pulse [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-accent-purple animate-pulse [animation-delay:300ms]" />
      </div>
      <p className="text-[10px] text-muted mono uppercase tracking-widest">{label}</p>
    </div>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  return (
    <div className="text-center py-8">
      <p className="text-xs text-accent-red">{message || "Something went wrong."}</p>
    </div>
  );
}
