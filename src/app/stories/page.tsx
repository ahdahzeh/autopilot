"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Story = {
  id: string;
  bullet_text: string;
  original_resume_text: string | null;
  source_job_id: string | null;
  tags: string[];
  created_at: string;
};

export default function StoriesPage() {
  const router = useRouter();
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stories");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not load story bank.");
      } else {
        setStories(data.stories ?? []);
      }
    } catch {
      setError("Could not load story bank.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id: string) {
    setStories((prev) => prev.filter((s) => s.id !== id));
    try {
      await fetch(`/api/stories/${id}`, { method: "DELETE" });
    } catch {
      // If delete fails, reload to restore truth
      load();
    }
  }

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  const filtered = query.trim()
    ? stories.filter((s) => {
        const q = query.toLowerCase();
        return (
          s.bullet_text.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q))
        );
      })
    : stories;

  return (
    <div className="min-h-screen px-4 md:px-8 lg:px-12 py-4 md:py-6" style={{ background: "var(--background)" }}>
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Auto<span className="text-accent-purple">pilot</span>
            </h1>
            <p className="text-[10px] text-muted mono uppercase tracking-widest mt-1">Story Bank</p>
          </div>
          <button
            onClick={() => router.push("/")}
            className="px-4 py-2 text-xs border border-border rounded-lg hover:bg-card transition-colors"
          >
            Back to Dashboard
          </button>
        </div>

        <p className="text-xs text-muted mb-4">
          Reusable accomplishments saved while tailoring. Pull from these on future applications.
        </p>

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search bullets or tags…"
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 mb-4"
        />

        {loading && (
          <p className="text-xs text-muted mono animate-pulse text-center py-12">Loading stories…</p>
        )}

        {error && <p className="text-xs text-accent-red text-center py-6">{error}</p>}

        {!loading && !error && filtered.length === 0 && (
          <div className="border border-dashed border-border rounded-xl p-12 text-center">
            <p className="text-sm text-muted">
              {query.trim() ? "No stories match that search." : "No saved stories yet."}
            </p>
            <p className="text-[10px] text-muted mt-2">
              Save bullets from the tailoring modal to start your story bank.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {filtered.map((s) => (
            <div key={s.id} className="border border-border rounded-xl p-4 bg-card space-y-2">
              <p className="text-xs leading-relaxed">{s.bullet_text}</p>
              {s.original_resume_text && s.original_resume_text !== s.bullet_text && (
                <details className="text-[10px] text-muted">
                  <summary className="cursor-pointer hover:text-foreground">Original</summary>
                  <p className="mt-1 italic">{s.original_resume_text}</p>
                </details>
              )}
              <div className="flex items-center justify-between pt-1">
                <div className="flex gap-1.5 flex-wrap">
                  {s.tags.map((t) => (
                    <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-background text-muted mono">
                      {t}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => copy(s.bullet_text, s.id)}
                    className="text-[10px] text-accent-purple hover:opacity-70"
                  >
                    {copiedId === s.id ? "Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={() => remove(s.id)}
                    className="text-[10px] text-accent-red hover:opacity-70"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <p className="text-[9px] text-muted mono">{new Date(s.created_at).toLocaleDateString()}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
