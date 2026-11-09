import { createClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Writes a follow-up email for an application and returns its subject and
 * body. It used to save the text as a Gmail draft, which needs the
 * gmail.compose scope; Gmail is connected read-only (a restricted scope needs
 * Google's verification), so every draft call failed. The dashboard opens the
 * text in the person's mail app or copies it instead, so Gmail needn't be
 * connected at all.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { company, role, dateApplied } = await request.json();
  if (!company || !role) {
    return Response.json({ error: "company and role are required" }, { status: 400 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .single();

  const displayName = profile?.display_name || "me";
  const appliedOn = dateApplied
    ? new Date(dateApplied).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "recently";

  const subject = `Following up on ${role} at ${company}`;
  const body = `Hi,

I wanted to follow up on my application for the ${role} position at ${company}. I applied on ${appliedOn} and remain very interested in this opportunity.

I'd love to learn more about the next steps in your process. Please let me know if there's anything else I can provide.

Best,
${displayName}`;

  return Response.json({ ok: true, subject, body });
}
