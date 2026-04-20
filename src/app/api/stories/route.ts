import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/stories — list current user's saved bullets
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("story_bank")
    .select("id, bullet_text, original_resume_text, source_job_id, tags, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ stories: data ?? [] });
}

// POST /api/stories — save a new bullet
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    bullet_text?: string;
    original_resume_text?: string | null;
    source_job_id?: string | null;
    tags?: string[];
  };

  if (!body.bullet_text || body.bullet_text.trim().length < 5) {
    return Response.json({ error: "Bullet text is required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("story_bank")
    .insert({
      user_id: user.id,
      bullet_text: body.bullet_text.trim(),
      original_resume_text: body.original_resume_text ?? null,
      source_job_id: body.source_job_id ?? null,
      tags: body.tags ?? [],
    })
    .select()
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ story: data }, { status: 201 });
}
