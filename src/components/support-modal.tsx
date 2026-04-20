"use client";

import { useEffect, useState } from "react";

const ZELLE = "wellengineeredexp@gmail.com";
const CASHTAG = "ahdahzeh";
const BMAC = "https://buymeacoffee.com/adxze";

export function SupportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cb-btn"
        style={{ fontSize: 11 }}
        aria-label="Support Autopilot"
      >
        <span aria-hidden>☕</span>
        Tip the chef
      </button>
      {open && <SupportModal onClose={() => setOpen(false)} />}
    </>
  );
}

function SupportModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState<"zelle" | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copyZelle() {
    navigator.clipboard.writeText(ZELLE).then(() => {
      setCopied("zelle");
      setTimeout(() => setCopied(null), 1600);
    });
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--rxl)",
          padding: "28px 24px 22px",
          maxWidth: 420,
          width: "100%",
          boxShadow: "0 24px 80px rgba(0,0,0,0.18)",
        }}
      >
        <div className="pill mb-4" style={{ background: "var(--bg2)" }}>
          <span className="pill-dot" />
          KEEP THE LIGHTS ON
        </div>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
            marginBottom: 8,
          }}
        >
          Free for you. Anthropic still bills me.
        </h2>
        <p style={{ fontSize: 13, color: "var(--tx3)", lineHeight: 1.55, marginBottom: 20 }}>
          Autopilot runs on real API tokens. If it landed you a callback,
          a coffee or two helps me keep it free for the next person.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <a
            href={BMAC}
            target="_blank"
            rel="noopener noreferrer"
            className="cb-btn cb-btn--solid"
            style={{ width: "100%", justifyContent: "center" }}
          >
            ☕ Buy me a coffee
          </a>
          <a
            href={`https://cash.app/$${CASHTAG}`}
            target="_blank"
            rel="noopener noreferrer"
            className="cb-btn"
            style={{ width: "100%", justifyContent: "center" }}
          >
            💵 Cash App · ${CASHTAG}
          </a>
          <button
            type="button"
            onClick={copyZelle}
            className="cb-btn"
            style={{ width: "100%", justifyContent: "space-between" }}
          >
            <span>🏦 Zelle · {ZELLE}</span>
            <span
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: "0.06em",
                color: copied ? "var(--success)" : "var(--tx3)",
              }}
            >
              {copied ? "COPIED" : "COPY"}
            </span>
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            display: "block",
            margin: "16px auto 0",
            fontSize: 11,
            color: "var(--tx3)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}
