// Zod schemas for the structured blocks. These get fed to generateObject so
// the AI SDK retries on parse failures and we never have to look at a
// half-truncated JSON blob again.
//
// IMPORTANT: Anthropic's output_config format rejects minimum/maximum on
// integers, minLength/maxLength on strings, and minItems/maxItems on arrays.
// Use only type + enum + describe. Validation depth comes from the model
// following the description, not JSON Schema constraints.

import { z } from "zod";

export const matchSchema = z.object({
  score: z.number().int().describe("Match score from 0 to 100"),
  headline: z.string().describe("One-sentence summary of the match"),
  strengths: z.array(z.string()).describe("3 to 5 key strengths that make this a good fit"),
  gaps: z.array(z.string()).describe("1 to 3 gaps or risks for this application"),
  verdict: z.enum(["strong", "decent", "stretch", "mismatch"]),
});
export type MatchOutput = z.infer<typeof matchSchema>;

export const keywordsSchema = z.object({
  keywords: z
    .array(
      z.object({
        term: z.string().describe("The keyword or phrase"),
        status: z.enum(["present", "missing", "do_not_claim"]),
        priority: z.enum(["high", "medium", "low"]),
        insertion_hint: z.string().describe("Where or how to insert this keyword"),
      }),
    )
    .describe("8 to 20 keywords from the job description"),
  coverage_score: z.number().int().describe("Coverage score from 0 to 100"),
  summary: z.string().describe("One-sentence summary of keyword coverage"),
});
export type KeywordsOutput = z.infer<typeof keywordsSchema>;

export const strategySchema = z.object({
  level_read: z.string().describe("What level this role is actually hiring for"),
  positioning: z.object({
    lead_with_role: z.string().describe("Which past role to lead with"),
    downplay_role: z.string().describe("Which past role to downplay or omit"),
    title_bridge: z.string().describe("How to frame your title for this role"),
    story_arc: z.string().describe("The narrative arc to use in this application"),
  }),
  salary_lens: z.object({
    assumption: z.string().describe("What the company likely budgets for this role"),
    band_estimate: z.string().describe("Estimated salary band"),
    negotiation_angle: z.string().describe("How to approach salary negotiation"),
  }),
  risks: z
    .array(
      z.object({
        risk: z.string().describe("A risk or red flag in this application"),
        mitigation: z.string().describe("How to address or counter this risk"),
      }),
    )
    .describe("1 to 3 risks with mitigations"),
});
export type StrategyOutput = z.infer<typeof strategySchema>;
