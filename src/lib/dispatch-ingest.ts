import { createHash } from "node:crypto";

// On-demand scrapes run the same pipeline as the daily ingest: a one-user
// GitHub Actions run of .github/workflows/ingest.yml. Until 2026-11-10 the
// app's "Run scrape now" button and the scrape fired at the end of onboarding
// called the hosted Railway scraper, which has been dead since June, so they
// answered "started" and then failed silently in the background: a new user
// saw an empty dashboard until the next morning's run.
//
// Needs GITHUB_DISPATCH_TOKEN: a fine-grained token for ahdahzeh/autopilot
// with Actions read and write. Without it, callers fall back to the daily run.

const REPO = process.env.GITHUB_DISPATCH_REPO || "ahdahzeh/autopilot";
const WORKFLOW = "ingest.yml";

/** The 8-character label run.ts uses for a user in the public Actions log. */
export function userHash(userId: string): string {
  return createHash("sha1").update(userId).digest("hex").slice(0, 8);
}

export function canDispatchIngest(): boolean {
  return Boolean(process.env.GITHUB_DISPATCH_TOKEN?.trim());
}

export async function dispatchIngestForUser(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = process.env.GITHUB_DISPATCH_TOKEN?.trim();
  if (!token) return { ok: false, error: "GITHUB_DISPATCH_TOKEN is not set" };
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    // The hash, not the id: workflow inputs are visible on the public run page.
    body: JSON.stringify({ ref: "main", inputs: { user: userHash(userId), send_emails: false } }),
  });
  if (res.status === 204) return { ok: true };
  const body = await res.text().catch(() => "");
  return { ok: false, error: `GitHub dispatch ${res.status}: ${body.slice(0, 200)}` };
}
