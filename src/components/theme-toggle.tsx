"use client";

import { useEffect, useState } from "react";

type Mode = "light" | "dark";

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => {
    const stored = (localStorage.getItem("theme") as Mode | null);
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initial: Mode = stored ?? (systemDark ? "dark" : "light");
    applyMode(initial);
    setMode(initial);
  }, []);

  function applyMode(next: Mode) {
    const root = document.documentElement;
    if (next === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem("theme", next);
  }

  function toggle() {
    const next: Mode = mode === "dark" ? "light" : "dark";
    applyMode(next);
    setMode(next);
  }

  if (!mode) {
    return <div className="w-[34px] h-[34px]" aria-hidden />;
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="cb-btn cb-btn--icon"
    >
      {mode === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
