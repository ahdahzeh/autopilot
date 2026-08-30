/**
 * Model comparison harness.
 *
 * Runs the real tailor prompts against one or more models and scores the
 * output with the SAME validator the API route uses (src/lib/output-guard.ts).
 * The question it answers is not "is this model good" but "does this model
 * satisfy the contract our prompts already state", which is what decides
 * whether it is safe to route production traffic to it.
 *
 *   npm run eval:models -- --models=gemma3:12b,qwen3:8b
 *   npm run eval:models -- --models=anthropic/claude-haiku-4.5
 *   npm run eval:models -- --models=claude-sonnet-4-6 --blocks=cover,bullets
 *   npm run eval:models -- --models=gemma3:12b --retry
 *
 * Backend is inferred from the id:
 *   "gemma3:12b"                  -> local Ollama at OLLAMA_HOST
 *   "anthropic/claude-haiku-4.5"  -> Vercel AI Gateway (needs AI_GATEWAY_API_KEY)
 *   "claude-sonnet-4-6"           -> Anthropic direct (needs ANTHROPIC_API_KEY)
 *
 * --retry re-runs violating blocks with the same correction suffix production
 * uses, so the reported pass rate matches what a user would actually get.
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
import { RESUME, JOB_DESCRIPTION, ROLE, COMPANY } from "./fixtures";

const STRUCTURED_SCHEMAS: Partial<Record<TailorBlock, z.ZodType>> = {
  match: matchSchema,
  keywords: keywordsSchema,
  strategy: strategySchema,
};

const MAX_TOKENS: Record<string, number> = {
  cover: 3200, prep: 2800, referral: 1800, strategy: 1600,
  keywords: 1800, bullets: 1800, jd_hygiene: 1200, short_cover: 800,
};

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

type Backend = "ollama" | "gateway" | "direct";

function backendFor(id: string): Backend {
  if (id.includes(":")) return "ollama";
  if (id.includes("/")) return "gateway";
  return "direct";
}

function arg(name: string, fallback = ""): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function parseJsonLoosely(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : cleaned;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

type Attempt = { parsed: unknown; inputTokens: number; outputTokens: number };

async function callOllama(id: string, prompt: string, tokens: number): Promise<Attempt> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: id,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      options: { num_predict: tokens },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  return {
    parsed: parseJsonLoosely(body.message?.content ?? ""),
    inputTokens: body.prompt_eval_count ?? 0,
    outputTokens: body.eval_count ?? 0,
  };
}

function resolveModel(id: string): LanguageModel {
  if (backendFor(id) === "direct") {
    // baseURL is pinned because a stray ANTHROPIC_BASE_URL in the shell (Claude
    // Code sets one) otherwise silently redirects these calls and 404s.
    return createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: "https://api.anthropic.com/v1",
    })(id);
  }
  return id as unknown as LanguageModel;
}

async function callSdk(id: string, block: TailorBlock, prompt: string, tokens: number): Promise<Attempt> {
  const schema = STRUCTURED_SCHEMAS[block];
  const model = resolveModel(id);
  if (schema) {
    const r = await generateObject({ model, prompt, schema, maxOutputTokens: tokens });
    return { parsed: r.object, inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 };
  }
  const r = await generateText({ model, prompt, maxOutputTokens: tokens });
  return { parsed: parseJsonLoosely(r.text), inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 };
}

async function generateOnce(id: string, block: TailorBlock, prompt: string, tokens: number): Promise<Attempt> {
  return backendFor(id) === "ollama"
    ? callOllama(id, prompt, tokens)
    : callSdk(id, block, prompt, tokens);
}

type Row = {
  model: string;
  block: TailorBlock;
  ok: boolean;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  violations: Violation[];
  retried: boolean;
  error?: string;
};

async function run(): Promise<void> {
  const models = arg("models").split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) {
    console.error("Pass at least one model: --models=gemma3:12b,anthropic/claude-haiku-4.5");
    process.exit(1);
  }
  const blocks = (arg("blocks")
    ? arg("blocks").split(",").map((b) => b.trim())
    : [...TAILOR_BLOCKS]) as TailorBlock[];
  const withRetry = hasFlag("retry");
  const tone = (arg("tone", "professional") as Tone);

  const promptArgs = { resume: RESUME, jobDescription: JOB_DESCRIPTION, role: ROLE, company: COMPANY, tone };
  const auditCtx = { resume: RESUME, jobDescription: JOB_DESCRIPTION };
  const rows: Row[] = [];

  for (const block of blocks) {
    const prompt = BLOCK_PROMPTS[block](promptArgs);
    const tokens = MAX_TOKENS[block] ?? 1400;
    console.error(`\n== ${block} ==`);

    for (const model of models) {
      const started = Date.now();
      try {
        const first = await generateOnce(model, block, prompt, tokens);
        if (!first.parsed) throw new Error("unparseable output");

        let parsed = correctWordCounts(block, normalizeDeep(first.parsed));
        let violations = auditBlock(block, parsed, auditCtx);
        let retried = false;
        let inputTokens = first.inputTokens;
        let outputTokens = first.outputTokens;

        if (withRetry && violations.length > 0) {
          retried = true;
          const second = await generateOnce(model, block, prompt + correctionSuffix(violations), tokens);
          inputTokens += second.inputTokens;
          outputTokens += second.outputTokens;
          if (second.parsed) {
            const cleaned = correctWordCounts(block, normalizeDeep(second.parsed));
            const after = auditBlock(block, cleaned, auditCtx);
            if (after.length < violations.length) {
              parsed = cleaned;
              violations = after;
            }
          }
        }

        const row: Row = {
          model, block, ok: true, ms: Date.now() - started,
          inputTokens, outputTokens, violations, retried,
        };
        rows.push(row);
        const status = violations.length === 0 ? "pass" : `${violations.length} violation(s)`;
        console.error(
          `   ${violations.length === 0 ? "ok  " : "FAIL"}  ${model.padEnd(30)} ${String(row.ms).padStart(7)}ms  ${status}` +
          (violations.length ? `\n        ${violations.map((v) => v.detail).join("\n        ")}` : ""),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rows.push({ model, block, ok: false, ms: Date.now() - started, inputTokens: 0, outputTokens: 0, violations: [], retried: false, error: message });
        console.error(`   ERR   ${model.padEnd(30)} ${message.slice(0, 110)}`);
      }
    }
  }

  console.error(`\n== summary${withRetry ? " (after one retry)" : ""} ==`);
  for (const model of models) {
    const mine = rows.filter((r) => r.model === model);
    const clean = mine.filter((r) => r.ok && r.violations.length === 0).length;
    const ms = mine.reduce((total, r) => total + r.ms, 0);
    const out = mine.reduce((total, r) => total + r.outputTokens, 0);
    console.error(`   ${model.padEnd(30)} ${clean}/${mine.length} blocks clean   ${(ms / 1000).toFixed(1)}s   ${out} output tokens`);
  }

  process.stdout.write(JSON.stringify(rows, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
