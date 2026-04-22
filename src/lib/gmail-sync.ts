import { createServiceClient } from "@/lib/supabase/server";

// Keywords that signal status changes
const PATTERNS = {
  Rejected: [
    /we.*moved forward with other/i, /not.*moving forward/i, /decided to.*pursue other/i,
    /position has been filled/i, /unfortunately.*not selected/i, /not a match/i,
    /will not be moving/i, /other candidates/i, /application.*not successful/i,
    /regret to inform/i, /we won't be moving/i, /not selected/i,
    /we.*decided.*not.*proceed/i, /no longer.*considering/i, /closed.*position/i,
    /not.*right.*fit/i, /decided to move in a different direction/i,
  ],
  Interview: [
    /interview/i, /schedule.*call/i, /like to speak with you/i, /next step/i,
    /phone screen/i, /video call/i, /meet with/i, /technical.*round/i,
    /recruiter.*call/i, /would love to chat/i, /connect.*discuss/i,
    /intro.*call/i, /chat.*role/i, /time.*speak/i, /availability/i,
    /want to learn more about you/i, /hiring.*process/i, /talent.*team/i,
    /reach out.*role/i, /following up.*application/i, /saw your.*profile/i,
    /excited.*opportunity/i, /great.*background/i,
  ],
  Offer: [
    /offer letter/i, /pleased to offer/i, /formal offer/i, /compensation package/i,
    /start date/i, /offer of employment/i, /excited to extend/i,
    /we.*extend.*offer/i, /ready.*make.*offer/i,
  ],
  Applied: [
    /application received/i, /we received your application/i, /thank you for applying/i,
    /application.*submitted/i, /we got your application/i, /your application.*been.*received/i,
    /application.*under review/i, /we'll be in touch/i,
  ],
};

type JobStatus = keyof typeof PATTERNS;

export type SyncResult = {
  skipped?: boolean;
  reason?: string;
  updated?: number;
  emails_scanned?: number;
  calendar_matched?: number;
  error?: string;
};

function classifyEmail(subject: string, snippet: string): JobStatus | null {
  const text = `${subject} ${snippet}`.toLowerCase();
  // Check in priority order: Rejected > Offer > Interview > Applied
  for (const status of ["Rejected", "Offer", "Interview", "Applied"] as JobStatus[]) {
    if (PATTERNS[status].some((p) => p.test(text))) return status;
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
  return domain.replace(/^(mail\.|e\.|email\.|info\.|no-?reply\.|notifications?\.|hi\.|hello\.|careers\.|jobs\.)/, "");
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

// Pull interview events from Google Calendar (gracefully skips if no calendar scope).
async function syncCalendarEvents(
  accessToken: string,
  jobs: Array<{ id: string; company: string; role: string; status: string }>,
): Promise<number> {
  const timeMin = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60-day lookback
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ahead

  const calQuery = encodeURIComponent("interview OR phone screen OR recruiter OR technical round OR hiring");
  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&q=${calQuery}&maxResults=100&singleEvents=true&orderBy=startTime`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!calRes.ok) return 0; // No calendar scope or API error — skip silently

  const calData = await calRes.json();
  const events: Array<{ summary?: string; description?: string; start?: { dateTime?: string; date?: string } }> =
    calData.items || [];

  if (!events.length) return 0;

  let matched = 0;
  for (const event of events) {
    const title = event.summary || "";
    const desc = event.description || "";
    const text = `${title} ${desc}`.toLowerCase();

    const isInterview =
      /interview|phone screen|recruiter|technical round|hiring manager|onsite|take.?home/i.test(text);
    if (!isInterview) continue;

    const matchedJob = jobs.find((job) => {
      const company = normalizeCompany(job.company);
      if (company.length < 3) return false;
      return new RegExp(`\\b${escapeRegex(company)}\\b`, "i").test(text);
    });

    if (!matchedJob) continue;

    const statusRank: Record<string, number> = {
      New: 0, Reviewing: 1, Applied: 2, Interview: 3, Offer: 4, Rejected: 1,
    };
    const currentRank = statusRank[matchedJob.status] ?? 0;
    if (currentRank < statusRank["Interview"]) {
      matchedJob.status = "Interview";
      matched++;
    }
  }

  return matched;
}

export async function syncUserGmail(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
): Promise<SyncResult> {
  const accessToken = await getValidAccessToken(supabase, userId);
  if (!accessToken) return { skipped: true, reason: "no valid token" };

  // Fetch all active jobs to match against
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, company, role, status")
    .eq("user_id", userId)
    .is("dismissed_at", null);

  if (!jobs?.length) return { updated: 0, emails_scanned: 0 };

  // ── Gmail scan ─────────────────────────────────────────────────────────────
  const after = Math.floor((Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000); // 60-day lookback
  const query = [
    `after:${after}`,
    "(interview OR \"phone screen\" OR \"next steps\" OR \"offer letter\"",
    "OR \"application received\" OR \"thank you for applying\"",
    "OR \"moving forward\" OR \"not moving forward\" OR \"we received your\"",
    "OR \"schedule a call\" OR \"recruiter\" OR \"talent team\"",
    "OR subject:application OR subject:offer OR subject:position OR subject:opportunity)",
  ].join(" ");

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=200`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!listRes.ok) return { error: "Gmail API error" };

  const listData = await listRes.json();
  const messages: Array<{ id: string }> = listData.messages || [];

  const updatedJobIds = new Set<string>();
  let updated = 0;

  const BATCH = 10;
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async ({ id: msgId }) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!msgRes.ok) return;

        const msg = await msgRes.json();
        const subject = msg.payload?.headers?.find((h: { name: string }) => h.name === "Subject")?.value || "";
        const from = msg.payload?.headers?.find((h: { name: string }) => h.name === "From")?.value || "";
        const snippet = msg.snippet || "";

        const newStatus = classifyEmail(subject, snippet);
        if (!newStatus) return;

        const matchedJob = jobs.find((job) => {
          if (updatedJobIds.has(job.id)) return false;
          const company = normalizeCompany(job.company);
          if (company.length < 3) return false;
          const fromDomain = extractDomain(from);
          if (fromDomain && fromDomain.includes(company.replace(/\s+/g, ""))) return true;
          const haystack = `${subject} ${snippet}`.toLowerCase();
          return new RegExp(`\\b${escapeRegex(company)}\\b`, "i").test(haystack);
        });

        if (!matchedJob) return;

        const statusRank: Record<string, number> = {
          New: 0, Reviewing: 1, Applied: 2, Interview: 3, Offer: 4, Rejected: 1,
        };
        const currentRank = statusRank[matchedJob.status] ?? 0;
        const newRank = statusRank[newStatus] ?? 0;

        if (newStatus === "Rejected" || newRank > currentRank) {
          updatedJobIds.add(matchedJob.id);
          await supabase.from("jobs").update({
            status: newStatus,
            ...(newStatus === "Applied" ? { date_applied: new Date().toISOString().split("T")[0] } : {}),
            ...(["Interview", "Offer"].includes(newStatus)
              ? { response_date: new Date().toISOString().split("T")[0] }
              : {}),
          }).eq("id", matchedJob.id);
          matchedJob.status = newStatus;
          updated++;
        }
      }),
    );
  }

  // ── Calendar scan ──────────────────────────────────────────────────────────
  const { data: refreshedJobs } = await supabase
    .from("jobs")
    .select("id, company, role, status")
    .eq("user_id", userId)
    .is("dismissed_at", null);

  let calendarMatched = 0;
  if (refreshedJobs?.length) {
    const mutableJobs = refreshedJobs.map((j) => ({ ...j }));
    calendarMatched = await syncCalendarEvents(accessToken, mutableJobs);

    for (const job of mutableJobs) {
      const original = refreshedJobs.find((j) => j.id === job.id);
      if (original && job.status !== original.status && job.status === "Interview") {
        await supabase.from("jobs").update({
          status: "Interview",
          response_date: new Date().toISOString().split("T")[0],
        }).eq("id", job.id);
      }
    }
  }

  return {
    updated: updated + calendarMatched,
    emails_scanned: messages.length,
    calendar_matched: calendarMatched,
  };
}
