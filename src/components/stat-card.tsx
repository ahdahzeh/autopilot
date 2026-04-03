"use client";

export function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "green" | "red" | "default";
}) {
  const accentClass =
    accent === "green"
      ? "text-accent-green"
      : accent === "red"
        ? "text-accent-red"
        : "text-foreground";

  return (
    <div className="border border-border rounded-lg p-4 bg-card">
      <p className="text-xs uppercase tracking-widest text-muted mb-1">{label}</p>
      <p className={`mono text-3xl font-bold ${accentClass}`}>{value}</p>
      {sub && <p className="text-xs text-muted mt-1 mono">{sub}</p>}
    </div>
  );
}
