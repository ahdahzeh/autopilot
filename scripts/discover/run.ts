#!/usr/bin/env tsx
/**
 * Company → ATS board discovery.
 *
 * Usage:
 *   tsx scripts/discover/run.ts --input scripts/discover/input.json --out scripts/discover/verified.json
 *
 * Input (JSON):  [{ name: string; domain?: string; hint?: "greenhouse"|"lever"|"ashby" }]
 * Output (JSON): [{ name: string; ats_type: "greenhouse"|"lever"|"ashby"; slug: string }]
 *
 * Flow per company:
 *   1. Generate slug candidates from the name (lowercase / dashed / first-word / pascal for Ashby).
 *   2. Probe Greenhouse / Lever / Ashby endpoints in parallel. First 200 w/ >=1 job wins.
 *   3. If no probe hits and a domain is provided, fetch {domain}/careers, parse outbound
 *      links to boards.greenhouse.io / jobs.lever.co / jobs.ashbyhq.com.
 *
 * Runs ~20 companies concurrently. ~8s timeout per HTTP call.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

type AtsType = "greenhouse" | "lever" | "ashby";
type InputCo = { name: string; domain?: string; hint?: AtsType };
type Match = { name: string; ats_type: AtsType; slug: string; source: "probe" | "careers" };

const CONCURRENCY = 20;
const HTTP_TIMEOUT_MS = 8000;
const UA = "autopilot-discover/1.0 (+https://autopilot.ahdahzeh.com)";

// --------- slug candidate generation ---------

const CORP_SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|the)\b/gi;

function slugCandidates(name: string): string[] {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[,\.'"`!?()]/g, "")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();

  const stripped = base.replace(CORP_SUFFIX, "").replace(/\s+/g, " ").trim();

  const variants = new Set<string>();
  const words = stripped.split(/\s+/).filter(Boolean);

  if (!words.length) return [];

  variants.add(words.join(""));         // "huggingface"
  variants.add(words.join("-"));        // "hugging-face"
  variants.add(words[0]);               // "hugging"
  if (words.length > 1) variants.add(words.join("_")); // "hugging_face"

  // Common irregular mappings
  const squeezed = words.join("").replace(/ai$/, "").replace(/hq$/, "");
  if (squeezed && squeezed !== words.join("")) variants.add(squeezed);

  return [...variants].filter((s) => s.length >= 2 && s.length <= 40);
}

function pascalSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[,\.'"`!?()]/g, "")
    .replace(/&/g, " and ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

// --------- HTTP helpers ---------

async function httpGet(url: string, accept = "application/json"): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: accept },
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  } finally {
    clearTimeout(t);
  }
}

// --------- per-ATS verifiers ---------
// Each returns true if the slug corresponds to a live board with >=1 job.

async function verifyGreenhouse(slug: string): Promise<boolean> {
  const r = await httpGet(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (r.status !== 200) return false;
  try {
    const data = JSON.parse(r.body);
    return Array.isArray(data?.jobs) && data.jobs.length > 0;
  } catch {
    return false;
  }
}

async function verifyLever(slug: string): Promise<boolean> {
  const r = await httpGet(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (r.status !== 200) return false;
  try {
    const data = JSON.parse(r.body);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

async function verifyAshby(slug: string): Promise<boolean> {
  const r = await httpGet(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  if (r.status !== 200) return false;
  try {
    const data = JSON.parse(r.body);
    return Array.isArray(data?.jobs) && data.jobs.length > 0;
  } catch {
    return false;
  }
}

const VERIFIERS: Record<AtsType, (s: string) => Promise<boolean>> = {
  greenhouse: verifyGreenhouse,
  lever: verifyLever,
  ashby: verifyAshby,
};

// --------- probe: try slug candidates across all ATS ---------

async function probe(co: InputCo): Promise<Match | null> {
  const candidates = slugCandidates(co.name);
  if (!candidates.length) return null;

  const atsOrder: AtsType[] = co.hint
    ? [co.hint, ...(["greenhouse", "lever", "ashby"] as AtsType[]).filter((a) => a !== co.hint)]
    : ["greenhouse", "lever", "ashby"];

  // Greenhouse + Lever use lowercase slugs.
  // Ashby frequently uses PascalCase (e.g. "Anthropic") — try both.
  for (const ats of atsOrder) {
    const tries =
      ats === "ashby" ? [...candidates, pascalSlug(co.name)] : candidates;
    for (const slug of tries) {
      if (await VERIFIERS[ats](slug)) {
        return { name: co.name, ats_type: ats, slug, source: "probe" };
      }
    }
  }
  return null;
}

// --------- careers-page fallback ---------

const CAREERS_PATTERNS: Array<{ re: RegExp; ats: AtsType }> = [
  { re: /boards\.greenhouse\.io\/embed\/job_board\?for=([a-z0-9_.-]+)/i, ats: "greenhouse" },
  { re: /boards\.greenhouse\.io\/([a-z0-9_.-]+)/i, ats: "greenhouse" },
  { re: /job-boards\.greenhouse\.io\/([a-z0-9_.-]+)/i, ats: "greenhouse" },
  { re: /jobs\.lever\.co\/([a-z0-9_.-]+)/i, ats: "lever" },
  { re: /jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/, ats: "ashby" },
];

async function parseCareersPage(domain: string): Promise<Omit<Match, "name" | "source"> | null> {
  const urls = [
    `https://${domain}/careers`,
    `https://${domain}/jobs`,
    `https://www.${domain}/careers`,
    `https://www.${domain}/jobs`,
  ];
  for (const url of urls) {
    const r = await httpGet(url, "text/html");
    if (r.status !== 200 || !r.body) continue;
    for (const { re, ats } of CAREERS_PATTERNS) {
      const m = r.body.match(re);
      if (m && m[1]) {
        const slug = m[1];
        // Verify the slug actually has jobs — avoids picking up dead embeds.
        if (await VERIFIERS[ats](slug)) {
          return { ats_type: ats, slug };
        }
      }
    }
  }
  return null;
}

async function discover(co: InputCo): Promise<Match | null> {
  const hit = await probe(co);
  if (hit) return hit;
  if (!co.domain) return null;
  const careers = await parseCareersPage(co.domain);
  if (careers) return { name: co.name, source: "careers", ...careers };
  return null;
}

// --------- concurrency runner ---------

async function runAll(input: InputCo[]): Promise<Match[]> {
  const out: Match[] = [];
  let i = 0;
  let done = 0;
  const total = input.length;
  const startedAt = Date.now();

  async function worker() {
    while (i < input.length) {
      const idx = i++;
      const co = input[idx];
      try {
        const m = await discover(co);
        if (m) out.push(m);
      } catch {
        // swallow — we log nothing individually to keep output clean
      }
      done++;
      if (done % 25 === 0 || done === total) {
        const pct = Math.round((done / total) * 100);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`  ${done}/${total} (${pct}%) · hits=${out.length} · ${elapsed}s elapsed`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

// --------- CLI ---------

function parseArgs(argv: string[]): { input: string; out: string } {
  const args: Record<string, string> = {};
  for (let j = 0; j < argv.length; j++) {
    const a = argv[j];
    if (a.startsWith("--")) args[a.slice(2)] = argv[j + 1] ?? "";
  }
  if (!args.input || !args.out) {
    console.error("Usage: tsx scripts/discover/run.ts --input <path.json> --out <path.json>");
    process.exit(1);
  }
  return { input: args.input, out: args.out };
}

async function main() {
  const { input, out } = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(path.resolve(input), "utf-8");
  const companies: InputCo[] = JSON.parse(raw);

  // Dedup by normalized name so we don't probe "Stripe" and "Stripe, Inc." twice.
  const seen = new Set<string>();
  const unique = companies.filter((c) => {
    const k = c.name.toLowerCase().replace(CORP_SUFFIX, "").replace(/\s+/g, " ").trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(`Discovering ATS boards for ${unique.length} companies (concurrency=${CONCURRENCY})…`);
  const matches = await runAll(unique);

  // Dedup matches by (ats_type, slug) — two input names can collide on the same board
  const byKey = new Map<string, Match>();
  for (const m of matches) {
    const k = `${m.ats_type}:${m.slug.toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, m);
  }
  const unique_matches = [...byKey.values()].sort((a, b) =>
    a.ats_type === b.ats_type ? a.slug.localeCompare(b.slug) : a.ats_type.localeCompare(b.ats_type),
  );

  await fs.writeFile(path.resolve(out), JSON.stringify(unique_matches, null, 2) + "\n", "utf-8");

  const byAts: Record<string, number> = {};
  for (const m of unique_matches) byAts[m.ats_type] = (byAts[m.ats_type] ?? 0) + 1;
  console.log(`\nDone. ${unique_matches.length} unique mappings:`);
  for (const [k, v] of Object.entries(byAts)) console.log(`  ${k}: ${v}`);
  console.log(`\nWritten to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
