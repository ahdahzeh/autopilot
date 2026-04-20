// Thin error capture wrapper. Routes log to Sentry if @sentry/nextjs is
// installed AND NEXT_PUBLIC_SENTRY_DSN is set; otherwise it falls back to
// console.error so nothing silently disappears in dev. The wrapper exists
// so route handlers can call captureError() everywhere without having to
// know whether Sentry is wired up yet.

type Context = Record<string, unknown>;

let sentryClient: { captureException: (e: unknown, ctx?: any) => void } | null = null;

async function ensureClient(): Promise<typeof sentryClient> {
  if (sentryClient) return sentryClient;
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return null;
  try {
    // Dynamic import so the dependency is optional. If @sentry/nextjs isn't
    // installed yet, ensureClient returns null and we log to console.
    // @ts-expect-error — optional peer; resolved at runtime if installed.
    const mod = await import("@sentry/nextjs").catch(() => null);
    if (!mod) return null;
    sentryClient = mod;
    return sentryClient;
  } catch {
    return null;
  }
}

export function captureError(err: unknown, context?: Context): void {
  // Fire-and-forget. Never throw from inside the logger.
  ensureClient()
    .then((client) => {
      if (client) {
        client.captureException(err, { extra: context ?? {} });
      } else {
        console.error("[autopilot]", context ?? {}, err);
      }
    })
    .catch(() => {
      console.error("[autopilot]", context ?? {}, err);
    });
}

