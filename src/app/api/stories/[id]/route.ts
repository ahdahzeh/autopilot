import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// DELETE /api/stories/[id] — remove a saved bullet
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const { error } = await supabase
    .from("story_bank")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true });
}
