"use client";

import { useState } from "react";

export function AddJobModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [location, setLocation] = useState("");
  const [applyLink, setApplyLink] = useState("");
  const [salaryRange, setSalaryRange] = useState("");
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, role, location, applyLink, salaryRange, source }),
    });

    setCompany("");
    setRole("");
    setLocation("");
    setApplyLink("");
    setSalaryRange("");
    setSource("");
    setLoading(false);
    onAdded();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl p-4 sm:p-6 w-full max-w-md mx-4 sm:mx-0 shadow-xl animate-fade-up">
        <h2 className="text-sm font-bold mb-4">Add Job</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Company" value={company} onChange={setCompany} required />
          <Field label="Role" value={role} onChange={setRole} required />
          <Field label="Location" value={location} onChange={setLocation} />
          <Field label="Apply Link" value={applyLink} onChange={setApplyLink} type="url" />
          <Field label="Salary Range" value={salaryRange} onChange={setSalaryRange} placeholder="e.g. 120K-160K" />
          <Field label="Source" value={source} onChange={setSource} placeholder="e.g. Friend referral" />
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 text-xs border border-border rounded-lg hover:bg-background transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !company || !role}
              className="flex-1 py-2 text-xs font-semibold rounded-lg bg-accent-purple text-white hover:opacity-90 transition disabled:opacity-50"
            >
              {loading ? "Adding..." : "Add Job"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-[9px] uppercase tracking-widest text-muted font-medium block mb-1">
        {label} {required && <span className="text-accent-red">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-accent-purple/30"
      />
    </div>
  );
}
