"use client";

import { useState, useRef } from "react";

type Mode = "file" | "text";

export function ResumeUpload({
  onUploaded,
  existingLength,
}: {
  onUploaded?: (length: number) => void;
  existingLength?: number;
}) {
  const [mode, setMode] = useState<Mode>("file");
  const [manualText, setManualText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(file?: File, text?: string) {
    setUploading(true);
    setError("");
    setSuccess(false);

    const form = new FormData();
    if (file) form.append("file", file);
    if (text) form.append("text", text);

    const res = await fetch("/api/resume", { method: "POST", body: form });
    const data = await res.json();

    setUploading(false);
    if (!res.ok) {
      setError(data.error || "Upload failed");
    } else {
      setSuccess(true);
      onUploaded?.(data.length);
    }
  }

  function handleFile(file: File) {
    const allowed = [".pdf", ".doc", ".docx", ".txt"];
    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (!allowed.includes(ext)) {
      setError("Only PDF, DOC, DOCX, or TXT files are supported.");
      return;
    }
    submit(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  return (
    <div className="space-y-3">
      {/* Mode tabs */}
      <div className="flex gap-1 p-1 bg-neutral-100 rounded-lg w-fit">
        {(["file", "text"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setError(""); setSuccess(false); }}
            className={`px-3 py-1 text-xs rounded-md transition-all ${
              mode === m ? "bg-white shadow-sm font-medium" : "text-muted hover:text-foreground"
            }`}
          >
            {m === "file" ? "Upload File" : "Paste Text"}
          </button>
        ))}
      </div>

      {!!existingLength && existingLength > 0 && !success && (
        <p className="text-[10px] text-accent-green mono">
          Resume on file — {existingLength.toLocaleString()} characters. Upload a new one to replace.
        </p>
      )}

      {mode === "file" && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
            dragOver
              ? "border-accent-purple bg-accent-purple/5"
              : "border-border hover:border-accent-purple/50 hover:bg-card"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          <div className="space-y-2">
            <p className="text-2xl">📄</p>
            <p className="text-sm font-medium">Drop your resume here</p>
            <p className="text-[10px] text-muted">PDF, DOC, DOCX, or TXT · Click to browse</p>
          </div>
        </div>
      )}

      {mode === "text" && (
        <div className="space-y-2">
          <textarea
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            rows={10}
            placeholder="Paste your resume text here — work experience, skills, education..."
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30 resize-none font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => submit(undefined, manualText)}
            disabled={uploading || manualText.trim().length < 50}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-foreground text-white hover:opacity-90 transition disabled:opacity-40"
          >
            {uploading ? "Saving..." : "Save Resume"}
          </button>
        </div>
      )}

      {uploading && mode === "file" && (
        <p className="text-xs text-muted animate-pulse">Extracting text from resume...</p>
      )}

      {error && <p className="text-xs text-accent-red">{error}</p>}

      {success && (
        <p className="text-xs text-accent-green font-medium">
          Resume saved successfully.
        </p>
      )}
    </div>
  );
}
