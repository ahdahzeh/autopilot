/**
 * Tailor cost measurement.
 *
 * Runs the exact prompt path /api/tailor uses (BLOCK_PROMPTS from
 * src/lib/tailor-prompts.ts, generateObject for the schema blocks,
 * generateText for the prose blocks, the unparseable-output retry and the
 * output-guard correction retry) once against Sonnet 4.6 on an entry-level
 * IT fixture, and prints token usage and dollar cost per block: for the
 * 9-block run the route performs on every "Tailor for this job" click, and
 * for the 5 blocks the job modal actually shows.
 *
 *   set -a; source .env.local; set +a
 *   npm run cost:tailor                                   # Sonnet 4.6, all blocks
 *   npm run cost:tailor -- --model=claude-haiku-4-5-20251001
 *   npm run cost:tailor -- --blocks=match,cover
 *
 * One run costs well under $1 (the 2026-10-20 run was $0.17). The pack price
 * in src/lib/billing.ts was set from that run; its numbers and the pricing
 * math are recorded next to DEFAULT_PACK_PRICE_CENTS so nobody has to re-run
 * this to understand the price.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";
import { generateObject, generateText, type LanguageModel } from "ai";
import {
  BLOCK_PROMPTS,
  TAILOR_BLOCKS,
  type TailorBlock,
  type Tone,
} from "../../src/lib/tailor-prompts";
import {
  keywordsSchema,
  matchSchema,
  strategySchema,
} from "../../src/lib/tailor-schemas";
import {
  auditBlock,
  correctWordCounts,
  correctionSuffix,
  normalizeDeep,
  type Violation,
} from "../../src/lib/output-guard";
import {
  MODEL_PRICES_PER_MTOK,
  STRIPE_FEE_FIXED_CENTS,
  STRIPE_FEE_PERCENT,
  getCreditPack,
  sumTokenUsage,
  tokenUsageOf,
  usageCostUsd,
  type TokenUsage,
} from "../../src/lib/billing";
import { COMPANY, JOB_DESCRIPTION, RESUME, ROLE } from "./fixtures";

const STRUCTURED_SCHEMAS: Partial<Record<TailorBlock, z.ZodType>> = {
  match: matchSchema,
  keywords: keywordsSchema,
  strategy: strategySchema,
};

// Same ceilings as the route. Keep in sync with src/app/api/tailor/route.ts.
const MAX_TOKENS: Record<string, number> = {
  cover: 3200, prep: 2800, referral: 1800, strategy: 1600,
  keywords: 1800, bullets: 1800, jd_hygiene: 1200, short_cover: 800,
};

// What the job modal renders (its tabs are match, bullets, cover, strategy,
// prep). The route still generates keywords, short_cover, jd_hygiene and
// referral on every click and nobody sees them: $0.052 of the $0.168 measured
// on 2026-10-20. Reported as an open issue with the billing change.
const UI_BLOCKS: TailorBlock[] = ["match", "bullets", "cover", "strategy", "prep"];

function arg(name: string, fallback = ""): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function parseJsonLoosely(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

type Call = TokenUsage & { ms: number };

type BlockResult = {
  block: TailorBlock;
  calls: Call[];
  violations: Violation[];
  retriedForParse: boolean;
  retriedForViolations: boolean;
  error?: string;
};

async function runBlock(model: LanguageModel, block: TailorBlock, tone: Tone): Promise<BlockResult> {
  const promptArgs = { resume: RESUME, jobDescription: JOB_DESCRIPTION, role: ROLE, company: COMPANY, tone };
  const auditCtx = { resume: RESUME, jobDescription: JOB_DESCRIPTION };
  const prompt = BLOCK_PROMPTS[block](promptArgs);
  const maxOutputTokens = MAX_TOKENS[block] ?? 1400;
  const schema = STRUCTURED_SCHEMAS[block];
  const calls: Call[] = [];

  const generateOnce = async (text: string, tokens: number): Promise<unknown> => {
    const started = Date.now();
    if (schema) {
      const r = await generateObject({ model, prompt: text, schema, maxOutputTokens: tokens });
      calls.push({ ...tokenUsageOf(r.usage), ms: Date.now() - started });
      return r.object;
    }
    const r = await generateText({ model, prompt: text, maxOutputTokens: tokens });
    calls.push({ ...tokenUsageOf(r.usage), ms: Date.now() - started });
    return parseJsonLoosely(r.text);
  };

  const result: BlockResult = { block, calls, violations: [], retriedForParse: false, retriedForViolations: false };
  try {
    let parsed = await generateOnce(prompt, maxOutputTokens);
    if (!parsed) {
      result.retriedForParse = true;
      parsed = await generateOnce(prompt, Math.round(maxOutputTokens * 1.6));
    }
    if (!parsed) {
      result.error = "unparseable output twice";
      return result;
    }
    parsed = correctWordCounts(block, normalizeDeep(parsed));
    let violations = auditBlock(block, parsed, auditCtx);
    if (violations.length > 0) {
      result.retriedForViolations = true;
      const second = await generateOnce(prompt + correctionSuffix(violations), maxOutputTokens);
      if (second) {
        const cleaned = correctWordCounts(block, normalizeDeep(second));
        const after = auditBlock(block, cleaned, auditCtx);
        if (after.length < violations.length) violations = after;
      }
    }
    result.violations = violations;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

const sum = (calls: Call[]): TokenUsage => sumTokenUsage(calls);

const usd = (n: number) => `$${n.toFixed(4)}`;

async function main(): Promise<void> {
  const modelId = arg("model", "claude-sonnet-4-6");
  const tone = arg("tone", "professional") as Tone;
  const blocks = (arg("blocks")
    ? arg("blocks").split(",").map((b) => b.trim())
    : [...TAILOR_BLOCKS]) as TailorBlock[];

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Load .env.local first: set -a; source .env.local; set +a");
    process.exit(1);
  }
  if (!MODEL_PRICES_PER_MTOK[modelId]) {
    console.error(`No price on file for ${modelId} in src/lib/billing.ts; add it before measuring.`);
    process.exit(1);
  }

  // baseURL is pinned because Claude Code sets ANTHROPIC_BASE_URL in the
  // shell, which would otherwise silently redirect these calls (same fix as
  // scripts/model-eval/run.ts).
  const model = createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: "https://api.anthropic.com/v1",
  })(modelId);

  console.log(`model: ${modelId}   tone: ${tone}   blocks: ${blocks.join(", ")}`);
  console.log(`resume: ${RESUME.length} chars   job description: ${JOB_DESCRIPTION.length} chars\n`);

  // Match first, then the rest in parallel, exactly like the route.
  const started = Date.now();
  const results: BlockResult[] = [];
  if (blocks.includes("match")) results.push(await runBlock(model, "match", tone));
  const rest = blocks.filter((b) => b !== "match");
  results.push(...(await Promise.all(rest.map((b) => runBlock(model, b, tone)))));
  const wallMs = Date.now() - started;

  const header = `${"block".padEnd(12)} ${"calls".padStart(5)} ${"input".padStart(7)} ${"output".padStart(7)} ${"cost".padStart(9)}  notes`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    const total = sum(r.calls);
    const cost = usageCostUsd(modelId, total) ?? 0;
    const notes = [
      r.error ? `ERROR ${r.error.slice(0, 60)}` : "",
      r.retriedForParse ? "parse retry" : "",
      r.retriedForViolations ? `guard retry (${r.violations.length} left)` : "",
    ].filter(Boolean).join(", ");
    console.log(
      `${r.block.padEnd(12)} ${String(r.calls.length).padStart(5)} ${String(total.inputTokens).padStart(7)} ${String(total.outputTokens).padStart(7)} ${usd(cost).padStart(9)}  ${notes}`,
    );
  }

  const all = sum(results.flatMap((r) => r.calls));
  const allCost = usageCostUsd(modelId, all) ?? 0;
  const ui = sum(results.filter((r) => UI_BLOCKS.includes(r.block)).flatMap((r) => r.calls));
  const uiCost = usageCostUsd(modelId, ui) ?? 0;
  const callCount = results.reduce((n, r) => n + r.calls.length, 0);

  console.log("-".repeat(header.length));
  console.log(`all ${results.length} blocks: ${callCount} calls, ${all.inputTokens} input + ${all.outputTokens} output tokens, cache read ${all.cacheReadTokens}, cost ${usd(allCost)}  (wall ${(wallMs / 1000).toFixed(1)}s)`);
  console.log(`modal's 5 blocks only: ${ui.inputTokens} input + ${ui.outputTokens} output tokens, cost ${usd(uiCost)}`);

  const price = MODEL_PRICES_PER_MTOK[modelId];
  console.log(`\nprices used: $${price.input}/MTok input, $${price.output}/MTok output (${modelId})`);

  // Pack economics at the measured full-run cost.
  const pack = getCreditPack();
  const anthropicPerPack = allCost * pack.credits;
  console.log(`\npack: ${pack.credits} credits. Anthropic cost per pack at the measured full run: ${usd(anthropicPerPack)}`);
  console.log(`${"price".padStart(7)} ${"stripe fee".padStart(11)} ${"net".padStart(8)} ${"margin over api".padStart(16)}`);
  for (const cents of [500, 600, 700, 800, 1000, 1200]) {
    const fee = cents * STRIPE_FEE_PERCENT + STRIPE_FEE_FIXED_CENTS;
    const net = (cents - fee) / 100;
    const margin = anthropicPerPack > 0 ? (net / anthropicPerPack - 1) * 100 : 0;
    const mark = cents === pack.priceCents ? "  <- configured" : "";
    console.log(`${("$" + (cents / 100).toFixed(2)).padStart(7)} ${("$" + (fee / 100).toFixed(2)).padStart(11)} ${("$" + net.toFixed(2)).padStart(8)} ${(margin.toFixed(0) + "%").padStart(16)}${mark}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
