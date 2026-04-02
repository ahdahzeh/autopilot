"use client";

type FunnelBar = { label: string; count: number; max: number; color: string };

export function MiniFunnel({ data }: { data: FunnelBar[] }) {
  return (
    <div className="mb-3">
      <p className="text-[7px] uppercase tracking-[1px] text-muted mb-1.5">Funnel</p>
      <div className="space-y-1">
        {data.map((bar) => (
          <div key={bar.label} className="flex items-center gap-1.5 text-[9px]">
            <span className="text-muted w-12 text-right shrink-0">{bar.label}</span>
            <div className="bg-neutral-200 h-2 flex-1 rounded-sm overflow-hidden">
              <div
                className="h-full rounded-sm"
                style={{
                  width: bar.max > 0 ? `${(bar.count / bar.max) * 100}%` : "0%",
                  backgroundColor: bar.color,
                }}
              />
            </div>
            <span className="mono font-semibold w-5 shrink-0">{bar.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
