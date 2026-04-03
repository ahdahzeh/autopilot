export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "var(--background)" }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight">
            Auto<span className="text-accent-purple">pilot</span>
          </h1>
          <p className="text-xs text-muted mt-1">Your job search, automated</p>
        </div>
        {children}
      </div>
    </div>
  );
}
