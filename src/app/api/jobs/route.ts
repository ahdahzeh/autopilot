import { createClient } from "@/lib/supabase/server";
import { mapRow } from "@/lib/supabase/jobs";
import {
  computeStats, applicationsPerWeek, sourceEffectiveness,
  statusBreakdown, computeHealthScore, categorizeActions, appsThisWeek,
} from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: rows, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("user_id", user.id)
      .is("dismissed_at", null)
      .order("date_found", { ascending: false });

    if (error) throw error;

    const jobs = (rows || []).map(mapRow);
    const stats = computeStats(jobs);
    const velocity = applicationsPerWeek(jobs);
    const sources = sourceEffectiveness(jobs);
    const statuses = statusBreakdown(jobs);
    const healthScore = computeHealthScore(jobs);
    const actions = categorizeActions(jobs);
    const weekApps = appsThisWeek(jobs);

    return Response.json({
      jobs,
      stats,
      velocity,
      sources,
      statuses,
      healthScore,
      actions,
      appsThisWeek: weekApps,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to fetch jobs:", error);
    return Response.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();

    const { error } = await supabase.from("jobs").insert({
      user_id: user.id,
      company: body.company,
      role: body.role,
      location: body.location || "",
      apply_link: body.applyLink || "",
      salary_range: body.salaryRange || "",
      source: body.source || "Manual",
      status: "New",
      date_found: new Date().toISOString().split("T")[0],
      manually_added: true,
    });

    if (error) throw error;

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Failed to add job:", error);
    return Response.json({ error: "Failed to add job" }, { status: 500 });
  }
}
