"use client";

import { useState, useRef, useEffect } from "react";

type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";

const REASONS: { value: DismissReason; label: string }[] = [
  { value: "not_interested", label: "Not Interested" },
  { value: "expired", label: "Expired" },
  { value: "scam", label: "Scam" },
  { value: "applied_elsewhere", label: "Applied Elsewhere" },
];

export function DismissButton({
  onDismiss,
}: {
  onDismiss: (reason: DismissReason) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        className="bg-neutral-100 text-muted hover:bg-neutral-200 px-2 py-0.5 rounded text-[10px] transition-colors"
        onClick={() => {
          if (!open) onDismiss("not_interested");
        }}
        onMouseDown={() => {
          longPressTimer.current = setTimeout(() => setOpen(true), 500);
        }}
        onMouseUp={() => {
          if (longPressTimer.current) clearTimeout(longPressTimer.current);
        }}
        onMouseLeave={() => {
          if (longPressTimer.current) clearTimeout(longPressTimer.current);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        Dismiss
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-border rounded-lg shadow-lg py-1 z-50 min-w-[160px]">
          {REASONS.map((r) => (
            <button
              key={r.value}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors"
              onClick={() => {
                onDismiss(r.value);
                setOpen(false);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
