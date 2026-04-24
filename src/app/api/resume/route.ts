import { after } from "next/server";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type LanguageModel } from "ai";
import { createClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/sentry";
import { MODELS } from "@/lib/tailor-prompts";
import { expandTitles } from "@/lib/title-expansion";
import { auditResumeDepth } from "@/lib/resume-audit";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUMMARIZE_THRESHOLD = 6000;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const text = formData.get("text") as string | null;

  let resumeText = "";

  if (text?.trim()) {
    resumeText = text.trim();
  } else if (file) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const name = file.name.toLowerCase();

    if (name.endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      resumeText = text;
    } else if (name.endsWith(".doc") || name.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      resumeText = result.value;
    } else if (name.endsWith(".txt")) {
      resumeText = buffer.toString("utf-8");
    } else {
      return Response.json({ error: "Unsupported file type. Use PDF, DOC, DOCX, or TXT." }, { status: 400 });
    }
  } else {
    return Response.json({ error: "No file or text provided" }, { status: 400 });
  }

  resumeText = resumeText.replace(/\s+/g, " ").trim();

  if (resumeText.length < 50) {
    return Response.json({ error: "Resume text too short. Please check your file." }, { status: 400 });
  }

  // Clear any prior summary so we don't serve stale highlights with new
  // resume text. The new summary backfills via after() below.
  const { error } = await supabase
    .from("profiles")
    .update({ resume_text: resumeText, resume_summary: null })
    .eq("id", user.id);

  if (error) {
    captureError(error, { route: "resume", stage: "save_text", userId: user.id });
    return Response.json({ error: error.message }, { status: 500 });
  }

  // For long resumes (> 6000 chars), generate a curated highlight summary
  // in the background. We respond to the user immediately; the summary is
  // ready for the next tailor call. Best-effort.
  if (resumeText.length > SUMMARIZE_THRESHOLD) {
    after(async () => {
      try {
        const summary = await summarizeResume(resumeText);
        if (summary) {
          await supabase
            .from("profiles")
            .update({ resume_summary: summary })
            .eq("id", user.id);
        }
      } catch (e) {
        captureError(e, { route: "resume", stage: "summarize", userId: user.id });
      }
    });
  }

  // Independently of summarization, kick off the two Haiku calls that
  // power matching: title expansion (seniority-aware variants) and the
  // resume depth audit (score + issues surfaced in settings). Both write
  // back to profiles and must never throw out of the after() block.
  after(async () => {
    try {
      const { data: prof } = await supabase
        .from("profiles")
        .select("target_titles, years_experience, anthropic_api_key")
        .eq("id", user.id)
        .maybeSingle();

      const targetTitles = Array.isArray(prof?.target_titles)
        ? (prof!.target_titles as string[])
        : [];
      const priorYoE =
        typeof prof?.years_experience === "number" ? prof!.years_experience : null;
      const userKey =
        (prof?.anthropic_api_key as string | null | undefined)?.trim() || undefined;

      const [audit, expansion] = await Promise.all([
        auditResumeDepth({
          resumeText,
          anthropicApiKey: userKey,
        }),
        expandTitles({
          targetTitles,
          yearsExperience: priorYoE,
          resumeText,
          anthropicApiKey: userKey,
        }),
      ]);

      const update: Record<string, unknown> = {
        resume_depth_score: audit.score,
        resume_depth_issues: audit.issues,
        expanded_titles: expansion.expandedTitles,
      };
      // Only overwrite years_experience when we actually derived a value.
      if (expansion.yearsExperience != null) {
        update.years_experience = expansion.yearsExperience;
      }

      const { error: updateErr } = await supabase
        .from("profiles")
        .update(update)
        .eq("id", user.id);
      if (updateErr) {
        captureError(updateErr, {
          route: "resume",
          stage: "post_save_update",
          userId: user.id,
        });
      }
    } catch (e) {
      captureError(e, { route: "resume", stage: "post_save_enrich", userId: user.id });
    }
  });

  return Response.json({
    ok: true,
    length: resumeText.length,
    summarizing: resumeText.length > SUMMARIZE_THRESHOLD,
  });
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("profiles")
    .select("resume_text")
    .eq("id", user.id)
    .single();

  return Response.json({ resume_text: data?.resume_text || "" });
}

async function summarizeResume(raw: string): Promise<string | null> {
  // Use Haiku for speed/cost. Summary just needs to capture the highlights
  // and be deterministic-ish, not produce shipping copy.
  const sharedKey = process.env.ANTHROPIC_API_KEY?.trim();
  let model: LanguageModel;
  if (sharedKey) {
    model = createAnthropic({ apiKey: sharedKey })(MODELS.haiku.directId);
  } else {
    model = MODELS.haiku.gatewayId;
  }

  const prompt = `
You are summarizing a resume so a downstream model can use it for job tailoring without losing critical signal. The summary will replace the raw resume text in prompts when the original is too long.

Rules:
- Output 1500 to 2500 characters total. No more.
- Preserve every employer, every role title, every date range, and every concrete metric (%, $, headcount, scale numbers) verbatim.
- Keep the resume's original chronological order.
- Compress prose. Drop filler ("responsible for", "worked on"). Keep verbs of consequence.
- For each role, keep the 2 to 4 strongest accomplishment bullets, rewritten tightly. If a bullet has a number, that bullet is mandatory.
- Keep the skills section intact if one exists.
- Keep education and certifications intact.
- Do not add commentary, headers, framing language, or any line that isn't on the resume.
- No em-dashes. Use commas, periods, or parentheses.

<resume>
${raw}
</resume>

Output the summary as plain text. No JSON, no markdown headers, no preamble.
  `.trim();

  const { text } = await generateText({
    model,
    prompt,
    maxOutputTokens: 1500,
  });

  const cleaned = text.replace(/\u2014/g, ", ").replace(/\u2013/g, "-").trim();
  return cleaned.length > 200 ? cleaned : null;
}
