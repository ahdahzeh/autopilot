"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type BestMatch = {
  id: string;
  company: string;
  role: string;
  score: number;
};

type WidgetState = {
  applied: number;
  responses: number;
  avgReplyDays: number | null;
  bestMatch: BestMatch | null;
};

export function ProgressWidget({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [state, setState] = useState<WidgetState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const supabase = createClient();

      const now = new Date();
      const sevenDaysAgoIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // today range in local-ish UTC terms
      const todayStart = new Date(now);
      todayStart.setUTCHours(0, 0, 0, 0);
      const todayEnd = new Date(todayStart);
      todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);

      const appliedQ = supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .is("dismissed_at", null)
        .gte("date_applied", sevenDaysAgoIso);

      const responsesQ = supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .is("dismissed_at", null)
        .gte("response_date", sevenDaysAgoIso);

      // For avg reply time: rows applied in the last 7 days with a response
      const replyQ = supabase
        .from("jobs")
        .select("date_applied,response_date")
        .is("dismissed_at", null)
        .gte("date_applied", sevenDaysAgoIso)
        .not("response_date", "is", null);

      const bestMatchQ = supabase
        .from("jobs")
        .select("id,company,role,match_score")
        .is("dismissed_at", null)
        .gte("date_found", todayStart.toISOString())
        .lt("date_found", todayEnd.toISOString())
        .not("match_score", "is", null)
        .order("match_score", { ascending: false })
        .limit(1);

      const [appliedRes, responsesRes, replyRes, bestRes] = await Promise.all([
        appliedQ,
        responsesQ,
        replyQ,
        bestMatchQ,
      ]);

      if (cancelled) return;

      const applied = appliedRes.count ?? 0;
      const responses = responsesRes.count ?? 0;

      let avgReplyDays: number | null = null;
      const replyRows = (replyRes.data || []) as Array<{
        date_applied: string | null;
        response_date: string | null;
      }>;
      const diffs = replyRows
        .map((r) => {
          if (!r.date_applied || !r.response_date) return null;
          const a = new Date(r.date_applied).getTime();
          const b = new Date(r.response_date).getTime();
          if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
          return (b - a) / (1000 * 60 * 60 * 24);
        })
        .filter((d): d is number => d !== null);
      if (diffs.length > 0) {
        avgReplyDays = Math.round((diffs.reduce((s, d) => s + d, 0) / diffs.length) * 10) / 10;
      }

      const bestRow = (bestRes.data || [])[0] as
        | { id: string; company: string | null; role: string | null; match_score: number | null }
        | undefined;
      const bestMatch: BestMatch | null = bestRow && bestRow.match_score != null
        ? {
            id: bestRow.id,
            company: bestRow.company || "Unknown",
            role: bestRow.role || "",
            score: bestRow.match_score,
          }
        : null;

      setState({ applied, responses, avgReplyDays, bestMatch });
      setLoading(false);
    }

    load().catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted mono animate-pulse">
          Application progress — loading…
        </p>
      </div>
    );
  }

  if (!state || state.applied === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted mb-2">
          Application progress — last 7 days
        </p>
        <p className="text-sm text-muted">
          Apply to your first job to see progress here.
        </p>
      </div>
    );
  }

  const { applied, responses, avgReplyDays, bestMatch } = state;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-widest text-muted mb-3">
        Application progress — last 7 days
      </p>

      <div className="flex flex-col md:flex-row md:items-end md:gap-8 gap-4">
        <div className="flex gap-6 md:gap-8">
          <div>
            <p className="mono text-2xl font-bold text-foreground leading-none">{applied}</p>
            <p className="text-[10px] uppercase tracking-widest text-muted mt-1">applied</p>
          </div>
          <div>
            <p className="mono text-2xl font-bold text-foreground leading-none">{responses}</p>
            <p className="text-[10px] uppercase tracking-widest text-muted mt-1">responses</p>
          </div>
          <div>
            <p className="mono text-2xl font-bold text-foreground leading-none">
              {avgReplyDays === null ? "—" : `${avgReplyDays}d`}
            </p>
            <p className="text-[10px] uppercase tracking-widest text-muted mt-1">avg reply time</p>
          </div>
        </div>

        {bestMatch && (
          <div className="md:ml-auto flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-widest text-muted">
              Best match today:
            </span>
            <button
              type="button"
              onClick={() => onOpenJob(bestMatch.id)}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs hover:bg-card-hover transition"
              aria-label={`Open ${bestMatch.company} ${bestMatch.role}`}
            >
              <span className="font-medium truncate max-w-[200px]">
                {bestMatch.company}
                {bestMatch.role ? ` · ${bestMatch.role}` : ""}
              </span>
              <span className="mono text-accent-green font-bold">{bestMatch.score}%</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
