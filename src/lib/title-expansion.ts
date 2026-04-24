// Seniority-aware title expansion.
//
// Given a user's declared target titles and resume text, ask Haiku to:
//   1. Derive years of experience from the resume.
//   2. Emit 6 to 10 title variants covering one seniority band up and down,
//      always including the originals verbatim.
//
// This runs in the background after a resume save so the user's job matching
// can widen past the literal title they entered without them having to
// hand-curate variants.

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { MODELS } from "@/lib/tailor-prompts";
import { captureError } from "@/lib/sentry";

const MAX_TITLES = 10;
const MIN_RESUME_CHARS = 200;

const expansionSchema = z.object({
  years_experience: z
    .number()
    .describe(
      "Total years of relevant professional experience derived from the resume, rounded to the nearest integer. Use 0 if the resume has no work history.",
    ),
  expanded_titles: z
    .array(z.string())
    .describe(
      "6 to 10 job title variants that cover one seniority band above and below the user's targets. Always include each original target title verbatim. Include seniority prefixes (Senior, Staff, Lead, Principal) proportional to years of experience. No duplicates.",
    ),
});

type ExpansionOutput = z.infer<typeof expansionSchema>;

export async function expandTitles(opts: {
  targetTitles: string[];
  yearsExperience: number | null;
  resumeText: string;
  anthropicApiKey?: string;
}): Promise<{ expandedTitles: string[]; yearsExperience: number | null }> {
  const targets = (opts.targetTitles ?? []).map((t) => t.trim()).filter(Boolean);
  const resume = (opts.resumeText ?? "").trim();

  // Defensive baseline: if we can't run the model, we still return the
  // originals so downstream logic has something to query on.
  const fallback = {
    expandedTitles: dedupeCap(targets),
    yearsExperience: null as number | null,
  };

  if (targets.length === 0) return fallback;
  if (resume.length < MIN_RESUME_CHARS) {
    // Not enough text to reason about seniority. Return originals unchanged.
    return fallback;
  }

  const directKey = opts.anthropicApiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  let model: LanguageModel;
  if (directKey) {
    model = createAnthropic({ apiKey: directKey })(MODELS.haiku.directId);
  } else {
    model = MODELS.haiku.gatewayId;
  }

  const yoeHint =
    opts.yearsExperience != null && Number.isFinite(opts.yearsExperience)
      ? `The user previously reported roughly ${opts.yearsExperience} years of experience. Use the resume as the source of truth if it disagrees.`
      : "The user did not report years of experience. Derive it from the resume.";

  const prompt = `
You expand a user's target job titles into seniority-aware variants for a job matching pipeline.

<target_titles>
${targets.map((t) => `- ${t}`).join("\n")}
</target_titles>

<resume>
${resume.slice(0, 8000)}
</resume>

Context: ${yoeHint}

Rules for expanded_titles:
- Always include every original target title verbatim.
- Add the matching seniority variants one band above AND one band below the user's current level, derived from years of experience.
  * 0 to 2 YoE: Junior / Associate / (base)
  * 3 to 5 YoE: (base) / Senior
  * 6 to 9 YoE: Senior / Staff / Lead
  * 10+ YoE: Staff / Lead / Principal / Director
- Do not invent job families (e.g. do not add "Product Manager" if the user only listed "Product Designer").
- No duplicates. No abbreviations like "Sr." — spell out "Senior".
- Return between 6 and 10 titles total. If the user gave multiple targets, keep the set balanced across families.

Return years_experience as an integer count derived from the resume's work history (round to the nearest year; use 0 if no history).
  `.trim();

  try {
    const { object } = await generateObject({
      model,
      prompt,
      schema: expansionSchema,
      maxOutputTokens: 600,
    });

    return normalizeOutput(object, targets);
  } catch (err) {
    captureError(err, { lib: "title-expansion", stage: "generateObject" });
    return fallback;
  }
}

function normalizeOutput(
  object: ExpansionOutput,
  targets: string[],
): { expandedTitles: string[]; yearsExperience: number | null } {
  const raw = Array.isArray(object.expanded_titles) ? object.expanded_titles : [];
  const cleaned = raw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean);

  // Always guarantee the original targets lead the list, even if the model
  // dropped one.
  const merged = [...targets, ...cleaned];
  const expandedTitles = dedupeCap(merged);

  const yearsRaw = object.years_experience;
  const yearsExperience =
    typeof yearsRaw === "number" && Number.isFinite(yearsRaw)
      ? Math.max(0, Math.round(yearsRaw))
      : null;

  return { expandedTitles, yearsExperience };
}

function dedupeCap(titles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of titles) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TITLES) break;
  }
  return out;
}
