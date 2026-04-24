import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Bulk-delete old jobs for the authenticated user.
 *
 * Accepts `{ olderThanDays: number }` (default 8). Anything in the user's
 * pipeline whose `date_found` is strictly older than today - N is hard
 * deleted. We intentionally hard delete rather than soft-dismiss: the user
 * explicitly asked to "delete" and keeping 30+ days of stale rows slows
 * every pipeline read.
 *
 * GET returns the count that *would* be deleted so the UI can show a preview
 * before the user commits. POST performs the delete and returns the count.
 */

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
  const cutoff = cutoffDate(days);

  const { count, error } = await supabase
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .lt("date_found", cutoff);

  if (error) {
    console.error("[jobs/bulk-delete] preview failed", error);
    return Response.json({ error: "Failed to preview delete" }, { status: 500 });
  }

  return Response.json({ days, cutoff, count: count ?? 0 });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const days = parseDays(body.olderThanDays);
  const cutoff = cutoffDate(days);

  // Count first so we can report how many were actually removed — .delete()
  // doesn't return row counts cleanly through PostgREST without select().
  const { count: pre } = await supabase
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .lt("date_found", cutoff);

  const { error } = await supabase
    .from("jobs")
    .delete()
    .eq("user_id", user.id)
    .lt("date_found", cutoff);

  if (error) {
    console.error("[jobs/bulk-delete] delete failed", error);
    return Response.json({ error: "Failed to delete jobs" }, { status: 500 });
  }

  return Response.json({ days, cutoff, deleted: pre ?? 0 });
}
