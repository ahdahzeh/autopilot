// Zod schemas for the structured blocks. These get fed to generateObject so
// the AI SDK retries on parse failures and we never have to look at a
// half-truncated JSON blob again.

import { z } from "zod";

export const matchSchema = z.object({
  score: z.number().int().describe("Match score from 0 to 100"),
  headline: z.string().min(1),
  strengths: z.array(z.string()).min(3).max(5),
  gaps: z.array(z.string()).min(1).max(3),
  verdict: z.enum(["strong", "decent", "stretch", "mismatch"]),
});
export type MatchOutput = z.infer<typeof matchSchema>;

export const keywordsSchema = z.object({
  keywords: z
    .array(
      z.object({
        term: z.string().min(1),
        status: z.enum(["present", "missing", "do_not_claim"]),
        priority: z.enum(["high", "medium", "low"]),
        insertion_hint: z.string(),
      }),
    )
    .min(8)
    .max(20),
  coverage_score: z.number().int().describe("Coverage score from 0 to 100"),
  summary: z.string().min(1),
});
export type KeywordsOutput = z.infer<typeof keywordsSchema>;

export const strategySchema = z.object({
  level_read: z.string().min(1),
  positioning: z.object({
    lead_with_role: z.string().min(1),
    downplay_role: z.string(),
    title_bridge: z.string(),
    story_arc: z.string().min(1),
  }),
  salary_lens: z.object({
    assumption: z.string().min(1),
    band_estimate: z.string().min(1),
    negotiation_angle: z.string().min(1),
  }),
  risks: z
    .array(
      z.object({
        risk: z.string().min(1),
        mitigation: z.string().min(1),
      }),
    )
    .min(1)
    .max(3),
});
export type StrategyOutput = z.infer<typeof strategySchema>;
