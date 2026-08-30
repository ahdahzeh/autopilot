// Deterministic checks on model output, run before anything reaches the user.
//
// Every tailor prompt ships a contract: no dashes, no banned phrases, no
// invented figures, exact item counts, a 480 to 520 word cover letter. Until
// now that contract only existed as instructions, which means it held exactly
// as well as the model felt like holding it. A 2026-08 comparison against
// llama3:8b, gemma3:12b and qwen3:8b found every one of them breaking it, and
// llama3 inventing a "67% reduction" that appears nowhere in the resume.
//
// The split matters:
//   - Punctuation and quote style are FIXED silently. No model can improve on
//     a character substitution, so a retry would only burn tokens.
//   - Banned phrases, invented figures and wrong counts are REPORTED as
//     violations, because fixing them needs the model to write different words.
//
// The point of this file is that a cheaper model becomes safe to use once its
// failures are caught mechanically instead of trusted away.

import type { TailorBlock } from "@/lib/tailor-prompts";

export type ViolationRule =
  | "banned_phrase"
  | "fabricated_figure"
  | "word_count"
  | "item_count"
  | "missing_field";

export type Violation = {
  rule: ViolationRule;
  detail: string;
};

// Lifted from OUTPUT_RULES in tailor-prompts.ts. Keep the two in sync: if a
// rule is worth telling the model, it is worth checking.
const BANNED_PHRASES: [RegExp, string][] = [
  [/\bI am writing to\b/i, '"I am writing to"'],
  [/\bI hope this (?:email |message )?finds you well\b/i, '"I hope this finds you well"'],
  [/\bAs a passionate\b/i, '"As a passionate"'],
  [/\bpassionate\b/i, '"passionate"'],
  [/\bproven track record\b/i, '"proven track record"'],
  [/\bresults[-\s]driven\b/i, '"results-driven"'],
  [/\bsynergy\b/i, '"synergy"'],
  [/\bleverag(?:e|es|ed|ing)\b/i, '"leverage" as a verb'],
  [/\bresponsible for\b/i, '"responsible for"'],
  [/\binvolved in\b/i, '"involved in"'],
];

// Emoji, per "No emoji in any generated text".
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

// A figure is a number wearing a unit: a percent, a currency amount, or a
// multiplier. Bare integers are deliberately excluded, because "5 paragraphs"
// and "3 designers" are structural, not claims about the candidate.
const FIGURE = /(?:\$\s?\d[\d,]*(?:\.\d+)?\s*[KMB]?\b)|(?:\d[\d,]*(?:\.\d+)?\s*(?:%|percent\b))|(?:\d[\d,]*(?:\.\d+)?\s*(?:x\b|×))/gi;

// Any number at all, used to build the permitted set from source documents.
const ANY_NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** Straight quotes, no dashes, no emoji. Applied without asking the model. */
export function normalizeText(input: string): string {
  return input
    .replace(/—/g, ", ")     // em-dash
    .replace(/–/g, "-")      // en-dash
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(EMOJI, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/[ \t]{2,}/g, " ")
    .trimEnd();
}

/** normalizeText over every string in an arbitrarily nested value. */
export function normalizeDeep<T>(value: T): T {
  if (typeof value === "string") return normalizeText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => normalizeDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

function canonical(numeric: string): string {
  const cleaned = numeric.replace(/[,\s$]/g, "");
  const asNumber = Number(cleaned);
  return Number.isFinite(asNumber) ? String(asNumber) : cleaned;
}

/** Every number appearing in the source documents the model is allowed to cite. */
export function permittedFigures(...sources: string[]): Set<string> {
  const set = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(ANY_NUMBER)) {
      set.add(canonical(match[0]));
    }
  }
  return set;
}

/**
 * Figures in `text` that carry a unit and cannot be traced to the resume or
 * the job description. These are the dangerous ones: a number a candidate
 * could repeat in an interview without knowing it was invented.
 */
export function fabricatedFigures(text: string, permitted: Set<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FIGURE)) {
    const raw = match[0];
    const numeric = raw.match(ANY_NUMBER)?.[0];
    if (!numeric) continue;
    if (!permitted.has(canonical(numeric))) found.add(raw.trim());
  }
  return [...found];
}

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, into));
  else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((v) => collectStrings(v, into));
  }
  return into;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export type AuditContext = {
  resume: string;
  jobDescription: string;
};

/**
 * Check one parsed block against its contract. Returns the violations that
 * need the model to try again; punctuation is already handled by normalizeDeep.
 */
export function auditBlock(
  block: TailorBlock,
  parsed: unknown,
  ctx: AuditContext,
): Violation[] {
  const violations: Violation[] = [];
  if (!parsed || typeof parsed !== "object") {
    return [{ rule: "missing_field", detail: "block returned no object" }];
  }

  const obj = parsed as Record<string, unknown>;
  const prose = collectStrings(parsed).join("\n");

  for (const [pattern, label] of BANNED_PHRASES) {
    if (pattern.test(prose)) {
      violations.push({ rule: "banned_phrase", detail: `${label} is banned by the prompt` });
    }
  }

  // Only prose blocks make claims about the candidate. The analytical blocks
  // (match, keywords, strategy, jd_hygiene) legitimately quote figures from
  // the job description while reasoning about it.
  const CLAIM_BLOCKS: TailorBlock[] = ["bullets", "cover", "short_cover", "referral"];
  if (CLAIM_BLOCKS.includes(block)) {
    const permitted = permittedFigures(ctx.resume, ctx.jobDescription);
    const invented = fabricatedFigures(prose, permitted);
    if (invented.length) {
      violations.push({
        rule: "fabricated_figure",
        detail: `${invented.join(", ")} appear in neither the resume nor the job description`,
      });
    }
  }

  if (block === "bullets") {
    const bullets = Array.isArray(obj.bullets) ? (obj.bullets as unknown[]) : null;
    if (!bullets) {
      violations.push({ rule: "missing_field", detail: "no bullets array" });
    } else {
      if (bullets.length !== 5) {
        violations.push({ rule: "item_count", detail: `${bullets.length} bullets, the prompt requires exactly 5` });
      }
      const thin = bullets.filter((b) => {
        const rewritten = (b as Record<string, unknown> | null)?.rewritten;
        return typeof rewritten !== "string" || !rewritten.trim();
      }).length;
      if (thin) violations.push({ rule: "missing_field", detail: `${thin} bullets have no rewrite` });
    }
  }

  if (block === "cover") {
    const paragraphs = Array.isArray(obj.paragraphs) ? (obj.paragraphs as unknown[]) : null;
    if (!paragraphs) {
      violations.push({ rule: "missing_field", detail: "no paragraphs array" });
    } else {
      if (paragraphs.length !== 5) {
        violations.push({ rule: "item_count", detail: `${paragraphs.length} paragraphs, the prompt requires 5` });
      }
      const words = countWords(paragraphs.join(" "));
      if (words < 480 || words > 520) {
        violations.push({ rule: "word_count", detail: `${words} words, the prompt requires 480 to 520` });
      }
    }
  }

  if (block === "short_cover") {
    const message = typeof obj.message === "string" ? obj.message : "";
    if (!message.trim()) {
      violations.push({ rule: "missing_field", detail: "no message" });
    } else {
      const words = countWords(message);
      if (words < 110 || words > 140) {
        violations.push({ rule: "word_count", detail: `${words} words, the prompt requires 110 to 140` });
      }
    }
  }

  return violations;
}

/**
 * Models consistently misreport their own length (503 claimed against 326
 * actual, in the comparison). Recompute the field rather than trusting it.
 */
export function correctWordCounts(block: TailorBlock, parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const obj = parsed as Record<string, unknown>;
  if (block === "cover" && Array.isArray(obj.paragraphs)) {
    return { ...obj, word_count: countWords(obj.paragraphs.join(" ")) };
  }
  if (block === "short_cover" && typeof obj.message === "string") {
    return { ...obj, word_count: countWords(obj.message) };
  }
  return parsed;
}

/** Appended to the original prompt on the one retry a violating block gets. */
export function correctionSuffix(violations: Violation[]): string {
  const lines = violations.map((v) => `- ${v.detail}`).join("\n");
  return `

YOUR PREVIOUS ATTEMPT WAS REJECTED. These specific problems were found:
${lines}

Produce the block again, in the same JSON shape, with every problem above fixed.
Do not explain the fix. Do not apologize. Return the corrected JSON only.
Count words yourself before returning if a word count was rejected.`;
}
