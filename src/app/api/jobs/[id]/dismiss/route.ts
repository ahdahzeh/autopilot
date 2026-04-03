import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();
    const reason = body.reason;

    if (!["expired", "scam", "not_interested", "applied_elsewhere"].includes(reason)) {
      return Response.json({ error: "Invalid reason" }, { status: 400 });
    }

    const { error } = await supabase
      .from("jobs")
      .update({
        dismissed_at: new Date().toISOString(),
        dismiss_reason: reason,
      })
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) throw error;

    return Response.json({ ok: true, id, reason });
  } catch (error) {
    console.error("Failed to dismiss job:", error);
    return Response.json({ error: "Failed to dismiss job" }, { status: 500 });
  }
}
