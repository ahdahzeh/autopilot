import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Parsed = { ats_type: "greenhouse" | "lever" | "ashby"; slug: string };

// Parse a Greenhouse / Lever / Ashby board URL or a raw "ats:slug" string.
// Accepts short-forms like "anthropic" if ats is provided separately.
export function parseBoardUrl(raw: string): Parsed | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Short-form: "greenhouse:anthropic" or "lever/notion"
  const shortMatch = trimmed.match(/^(greenhouse|lever|ashby)[:/ ]+([a-z0-9][a-z0-9-_.]*)$/i);
  if (shortMatch) {
    return { ats_type: shortMatch[1].toLowerCase() as Parsed["ats_type"], slug: shortMatch[2].toLowerCase() };
  }

  // URL forms — normalize protocol
  let url = trimmed;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");

  const patterns: Array<{ host: RegExp; path: RegExp; ats: Parsed["ats_type"] }> = [
    { host: /(^|\.)greenhouse\.io$/, path: /^\/?([a-z0-9][a-z0-9-_.]*)/i, ats: "greenhouse" },
    { host: /(^|\.)lever\.co$/, path: /^\/?([a-z0-9][a-z0-9-_.]*)/i, ats: "lever" },
    { host: /(^|\.)ashbyhq\.com$/, path: /^\/?([a-z0-9][a-z0-9-_.]*)/i, ats: "ashby" },
  ];

  for (const p of patterns) {
    if (p.host.test(host)) {
      const m = path.match(p.path);
      if (m && m[1]) return { ats_type: p.ats, slug: m[1].toLowerCase() };
    }
  }
  return null;
}

// GET /api/companies — list current user's personal additions + pool_count.
// Global seed rows (user_id IS NULL) are not shown individually here — the UI
// surfaces the aggregate count so users know the pool is active.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [userRows, poolCount] = await Promise.all([
    supabase
      .from("target_companies")
      .select("id, ats_type, slug, name, active, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    // Use service client so we bypass RLS and get the true global count.
    createServiceClient()
      .from("target_companies")
      .select("*", { count: "exact", head: true })
      .eq("active", true),
  ]);

  if (userRows.error) return Response.json({ error: userRows.error.message }, { status: 500 });
  return Response.json({
    companies: userRows.data ?? [],
    pool_count: poolCount.count ?? 0,
  });
}

// POST /api/companies — add a company by URL or short-form
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { url?: string; name?: string };
  const parsed = parseBoardUrl(body.url ?? "");
  if (!parsed) {
    return Response.json(
      { error: "Could not parse board URL. Use jobs.lever.co/..., boards.greenhouse.io/..., or jobs.ashbyhq.com/..." },
      { status: 400 },
    );
  }

  const name = (body.name ?? "").trim() || parsed.slug;

  const { data, error } = await supabase
    .from("target_companies")
    .upsert(
      {
        user_id: user.id,
        ats_type: parsed.ats_type,
        slug: parsed.slug,
        name,
        active: true,
      },
      { onConflict: "user_id,ats_type,slug" },
    )
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ company: data }, { status: 201 });
}

// DELETE /api/companies?id=... — remove one of the user's tracked companies
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase
    .from("target_companies")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
