"use client";

import { useEffect, useState } from "react";

type ToastItem = {
  id: string;
  message: string;
  onUndo: () => void;
};

let addToastFn: ((toast: ToastItem) => void) | null = null;

export function showToast(toast: ToastItem) {
  addToastFn?.(toast);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<(ToastItem & { expiring: boolean })[]>([]);

  useEffect(() => {
    addToastFn = (toast) => {
      setToasts((prev) => [...prev, { ...toast, expiring: false }]);
      setTimeout(() => {
        setToasts((prev) => prev.map((t) => (t.id === toast.id ? { ...t, expiring: true } : t)));
      }, 4500);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 5000);
    };
    return () => { addToastFn = null; };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center gap-3 bg-foreground text-background px-4 py-2.5 rounded-lg shadow-lg text-sm transition-opacity duration-500 ${toast.expiring ? "opacity-0" : "opacity-100"}`}
        >
          <span>{toast.message}</span>
          <button
            onClick={() => {
              toast.onUndo();
              setToasts((prev) => prev.filter((t) => t.id !== toast.id));
            }}
            className="font-medium text-accent-green hover:underline text-xs"
          >
            Undo
          </button>
        </div>
      ))}
    </div>
  );
}
