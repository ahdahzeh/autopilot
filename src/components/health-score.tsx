"use client";

import type { HealthScore as HealthScoreType } from "@/lib/analytics";

export function HealthScore({ data }: { data: HealthScoreType }) {
  return (
    <div className="text-center pb-4 mb-4 border-b border-border">
      <p className="text-[7px] uppercase tracking-[2px] text-muted mb-1.5">Pipeline Health</p>
      <p className="mono text-5xl font-extrabold leading-none" style={{ color: data.color }}>
        {data.score}
      </p>
      <p className="text-[10px] font-semibold mt-1" style={{ color: data.color }}>
        {data.label}
      </p>
      <p className="text-[9px] text-muted mt-1">{data.diagnosis}</p>
    </div>
  );
}
