import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Bulk-delete old jobs for the authenticated user.
 *
 * Accepts `{ olderThanDays: number, includeAll?: boolean }` (default 8,
 * includeAll=false). Anything in the user's pipeline whose `date_found` is
 * strictly older than today - N is hard deleted.
 *
 * By default we only delete `New` status rows so the user doesn't lose
 * their Applied / Interview / Rejected / Offer history just because the
 * posting is old. Pass `includeAll: true` to nuke every status.
 *
 * GET returns the count that *would* be deleted so the UI can show a preview
 * before the user commits. POST performs the delete and returns the count.
 */

// Status values we consider user-actioned — never deleted unless
// includeAll=true is passed explicitly.
const ACTIONED_STATUSES = ["Applied", "Interview", "Offer", "Rejected"];

function cutoffDate(days: number): string {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().split("T")[0];
}

function parseDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 8;
  // Cap at 365 so a malformed request can't wipe the whole table by accident.
  return Math.min(365, Math.floor(n));
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const days = parseDays(url.searchParams.get("days"));
  const includeAll = url.searchParams.get("includeAll") === "1";
  const cutoff = cutoffDate(days);

  let q = supabase
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .lt("date_found", cutoff);
  if (!includeAll) q = q.not("status", "in", `(${ACTIONED_STATUSES.join(",")})`);

  const { count, error } = await q;

  if (error) {
    console.error("[jobs/bulk-delete] preview failed", error);
    return Response.json({ error: "Failed to preview delete" }, { status: 500 });
  }

  return Response.json({ days, cutoff, includeAll, count: count ?? 0 });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const days = parseDays(body.olderThanDays);
  const includeAll = body.includeAll === true;
  const cutoff = cutoffDate(days);

  // Count first so we can report how many were actually removed — .delete()
  // doesn't return row counts cleanly through PostgREST without select().
  let countQ = supabase
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .lt("date_found", cutoff);
  if (!includeAll) countQ = countQ.not("status", "in", `(${ACTIONED_STATUSES.join(",")})`);
  const { count: pre } = await countQ;

  let delQ = supabase
    .from("jobs")
    .delete()
    .eq("user_id", user.id)
    .lt("date_found", cutoff);
  if (!includeAll) delQ = delQ.not("status", "in", `(${ACTIONED_STATUSES.join(",")})`);
  const { error } = await delQ;

  if (error) {
    console.error("[jobs/bulk-delete] delete failed", error);
    return Response.json({ error: "Failed to delete jobs" }, { status: 500 });
  }

  return Response.json({ days, cutoff, includeAll, deleted: pre ?? 0 });
}
