import { createClient, createServiceClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// Keywords that signal status changes
const PATTERNS = {
  Rejected: [
    /we.*moved forward with other/i, /not.*moving forward/i, /decided to.*pursue other/i,
    /position has been filled/i, /unfortunately.*not selected/i, /not a match/i,
    /will not be moving/i, /other candidates/i, /application.*not successful/i,
    /regret to inform/i, /we won't be moving/i, /not selected/i,
  ],
  Interview: [
    /interview/i, /schedule.*call/i, /like to speak with you/i, /next step/i,
    /phone screen/i, /video call/i, /meet with/i, /technical.*round/i,
    /recruiter.*call/i, /would love to chat/i, /connect.*discuss/i,
  ],
  Offer: [
    /offer letter/i, /pleased to offer/i, /formal offer/i, /compensation package/i,
    /start date/i, /offer of employment/i, /excited to extend/i,
  ],
  Applied: [
    /application received/i, /we received your application/i, /thank you for applying/i,
    /application.*submitted/i, /we got your application/i,
  ],
};

type JobStatus = keyof typeof PATTERNS;

function classifyEmail(subject: string, snippet: string): JobStatus | null {
  const text = `${subject} ${snippet}`.toLowerCase();
  for (const [status, patterns] of Object.entries(PATTERNS)) {
    if (patterns.some((p) => p.test(text))) return status as JobStatus;
  }
  return null;
}

function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b\.?/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

function extractDomain(fromHeader: string): string | null {
  const match = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
  const addr = match?.[1] ?? match?.[0];
  if (!addr || !addr.includes("@")) return null;
  const domain = addr.split("@")[1]?.toLowerCase() ?? "";
  return domain.replace(/^(mail\.|e\.|email\.|info\.|no-?reply\.|notifications?\.|hi\.|hello\.)/, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getValidAccessToken(supabase: ReturnType<typeof createServiceClient>, userId: string) {
  const { data: tokens } = await supabase
    .from("gmail_tokens")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!tokens) return null;

  // Check if token is still valid (5 min buffer)
  if (new Date(tokens.token_expiry) > new Date(Date.now() + 5 * 60 * 1000)) {
    return tokens.access_token;
  }

  // Refresh the token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) return null;

  const refreshed = await res.json();
  const expiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

  await supabase.from("gmail_tokens").update({
    access_token: refreshed.access_token,
    token_expiry: expiry,
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);

  return refreshed.access_token;
}

async function syncUserGmail(supabase: ReturnType<typeof createServiceClient>, userId: string) {
  const accessToken = await getValidAccessToken(supabase, userId);
  if (!accessToken) return { skipped: true, reason: "no valid token" };

  // Fetch user's jobs to match against
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, company, role, status")
    .eq("user_id", userId)
    .is("dismissed_at", null);

  if (!jobs?.length) return { updated: 0 };

  // Search Gmail for job-related emails in the last 30 days
  const after = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const query = `after:${after} (subject:application OR subject:interview OR subject:offer OR subject:position OR subject:role OR subject:opportunity)`;

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!listRes.ok) return { error: "Gmail API error" };

  const listData = await listRes.json();
  const messages = listData.messages || [];

  let updated = 0;

  for (const { id: msgId } of messages) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!msgRes.ok) continue;

    const msg = await msgRes.json();
    const subject = msg.payload?.headers?.find((h: { name: string }) => h.name === "Subject")?.value || "";
    const from = msg.payload?.headers?.find((h: { name: string }) => h.name === "From")?.value || "";
    const snippet = msg.snippet || "";

    const newStatus = classifyEmail(subject, snippet);
    if (!newStatus) continue;

    // Match email to a job by company. Short/common names ("Hinge", "Meta",
    // "Ivy") caused false positives via loose substring matching, so we now
    // require either a domain match on the From header or a whole-word match
    // on the subject/snippet.
    const matchedJob = jobs.find((job) => {
      const company = normalizeCompany(job.company);
      if (company.length < 4) return false;
      const fromDomain = extractDomain(from);
      if (fromDomain && fromDomain.includes(company)) return true;
      const haystack = `${subject} ${snippet}`.toLowerCase();
      const wordBoundary = new RegExp(`\\b${escapeRegex(company)}\\b`, "i");
      return wordBoundary.test(haystack);
    });

    if (!matchedJob) continue;

    // Only upgrade status (don't overwrite Interview with Applied, etc.)
    const statusRank: Record<string, number> = {
      New: 0, Reviewing: 1, Applied: 2, Interview: 3, Offer: 4, Rejected: 1,
    };
    const currentRank = statusRank[matchedJob.status] ?? 0;
    const newRank = statusRank[newStatus] ?? 0;

    if (newStatus === "Rejected" || newRank > currentRank) {
      await supabase.from("jobs").update({
        status: newStatus,
        ...(newStatus === "Applied" ? { date_applied: new Date().toISOString().split("T")[0] } : {}),
        ...(newStatus === "Interview" || newStatus === "Offer" ? { response_date: new Date().toISOString().split("T")[0] } : {}),
      }).eq("id", matchedJob.id);
      updated++;
    }
  }

  return { updated, emails_scanned: messages.length };
}

export async function POST(request: NextRequest) {
  // Called by cron or manually
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: users } = await supabase
    .from("profiles")
    .select("id")
    .eq("gmail_connected", true)
    .eq("onboarded", true);

  if (!users?.length) return Response.json({ processed: 0 });

  const results = await Promise.all(
    users.map((u) => syncUserGmail(supabase, u.id).then((r) => ({ user_id: u.id, ...r })))
  );

  return Response.json({ processed: users.length, results });
}

// Allow a single user to trigger their own sync
export async function GET() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const result = await syncUserGmail(svc, user.id);
  return Response.json(result);
}
