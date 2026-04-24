// Resume depth audit.
//
// Scores a resume on how useful it will be for semantic job matching and
// returns a short list of fixable issues. The score is surfaced in settings
// with a honest nudge (e.g. "Your resume scores 58/100 — add metrics to any
// 3 bullets to improve match quality"). Goal: helpful, not harsh.

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { MODELS } from "@/lib/tailor-prompts";
import { captureError } from "@/lib/sentry";

const MIN_RESUME_CHARS = 200;

const auditSchema = z.object({
  depth_score: z
    .number()
    .describe(
      "Integer 0 to 100 measuring how scoreable this resume is for semantic job matching. 100 = dense with quantified outcomes, clear role history, named tools and skills. 60 = average, mix of signal and filler. Below 40 = too thin to match well.",
    ),
  issues: z
    .array(z.string())
    .describe(
      "0 to 5 short phrases naming specific, fixable weaknesses (e.g. 'no quantified outcomes', 'no skills section', 'vague bullets', 'role dates missing'). Empty array if the resume is already strong.",
    ),
});

type AuditOutput = z.infer<typeof auditSchema>;

export async function auditResumeDepth(opts: {
  resumeText: string;
  anthropicApiKey?: string;
}): Promise<{ score: number; issues: string[] }> {
  const resume = (opts.resumeText ?? "").trim();

  // Resumes that are too short to reason about get a conservative floor
  // score plus a single diagnostic issue. No model call.
  if (resume.length < MIN_RESUME_CHARS) {
    return {
      score: 20,
      issues: ["resume text is too short to match accurately"],
    };
  }

  const directKey = opts.anthropicApiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  let model: LanguageModel;
  if (directKey) {
    model = createAnthropic({ apiKey: directKey })(MODELS.haiku.directId);
  } else {
    model = MODELS.haiku.gatewayId;
  }

  const prompt = `
You are auditing a resume so a job-matching system can tell the user how useful their resume is and how to improve it. The score and issues list will be shown in settings with a nudge like "Your resume scores 58/100 — add metrics to any 3 bullets to improve match quality."

Be honest but not harsh. The user wrote this. Name fixable weaknesses, don't moralize.

Scoring rubric for depth_score (0 to 100 integer):
- 90 to 100: Dense. Clear role history with dates, strong bullets that pair action with outcome, named technologies or tools, multiple quantified results.
- 75 to 89: Solid. Most roles have real accomplishments, some metrics, clear skills signal.
- 60 to 74: Average. Structure is fine but bullets are task-shaped ("responsible for") more than outcome-shaped. Sparse metrics.
- 40 to 59: Thin. Role titles and dates exist but bullets are generic, no numbers, no named tools.
- 0 to 39: Too thin to match on. Missing dates, missing companies, or effectively a bio paragraph.

Issues (0 to 5 short phrases, lowercase, no punctuation):
- Call out specific, fixable things. Examples: "no quantified outcomes", "no skills section", "vague bullets", "missing role dates", "no company names", "tool names missing", "single long paragraph with no structure".
- Do not list more than 5 issues. Return an empty array if the resume is already strong.
- Each phrase is 2 to 6 words.

<resume>
${resume.slice(0, 8000)}
</resume>
  `.trim();

  try {
    const { object } = await generateObject({
      model,
      prompt,
      schema: auditSchema,
      maxOutputTokens: 400,
    });

    return normalizeOutput(object);
  } catch (err) {
    captureError(err, { lib: "resume-audit", stage: "generateObject" });
    // Conservative middle-of-the-road fallback so we never block the user on
    // a model failure. Leave issues empty rather than inventing one.
    return { score: 60, issues: [] };
  }
}

function normalizeOutput(object: AuditOutput): { score: number; issues: string[] } {
  const rawScore = object.depth_score;
  const score =
    typeof rawScore === "number" && Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : 60;

  const rawIssues = Array.isArray(object.issues) ? object.issues : [];
  const issues = rawIssues
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);

  return { score, issues };
}
