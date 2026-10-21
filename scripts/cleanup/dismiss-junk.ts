/**
 * Mark low-score junk as dismissed. Never deletes.
 *
 * Until 2026-10-20 the scraper inserted every scored job, because users'
 * min_match_score defaults to 0: 138 of the 387 jobs created since 2026-10-16
 * had match_score 0-2 (measured 2026-10-20), none of them applied to or
 * dismissed. The scraper now applies MIN_INSERT_SCORE (default 3) to
 * Haiku-scored jobs before insert. This sweeps the rows that predate the
 * floor so the feed matches what the scraper would insert today:
 *
 *   created since 2026-10-16, status 'New', never applied, not yet dismissed,
 *   Haiku-scored (score_reasoning present), match_score below the floor
 *     -> dismissed_at = now(), dismiss_reason = 'auto: low match quality'
 *
 * Heuristic-only rows (no score_reasoning) are skipped for the same reason the
 * scraper exempts them: that scale is compressed, and a 0 there usually means
 * "no resume yet", not "bad match". --include-heuristic widens the sweep.
 *
 * Dry run by default; prints counts per source and per user (short hashes,
 * the same sha256[:8] the scraper logs). Writes only with --apply.
 *
 *   npx tsx scripts/cleanup/dismiss-junk.ts
 *   npx tsx scripts/cleanup/dismiss-junk.ts --apply
 *   npx tsx scripts/cleanup/dismiss-junk.ts --floor=4 --since=2026-10-01 --include-heuristic
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Same default as scraper/main.py; MIN_INSERT_SCORE overrides both.
const DEFAULT_FLOOR = 3;
const DEFAULT_SINCE = "2026-10-16";
const DISMISS_REASON = "auto: low match quality";
const PAGE_SIZE = 1000;
const UPDATE_CHUNK = 200;

type JunkRow = { id: string; user_id: string; source: string; match_score: number | null };

function optionValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function shortUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

function countBy<T>(rows: T[], key: (row: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const includeHeuristic = args.includes("--include-heuristic");
  const floor = Number(optionValue(args, "--floor") ?? process.env.MIN_INSERT_SCORE ?? DEFAULT_FLOOR);
  const since = optionValue(args, "--since") ?? DEFAULT_SINCE;

  if (!Number.isInteger(floor) || floor < 0 || floor > 10) {
    throw new Error(`--floor must be an integer from 0 to 10, got ${String(floor)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`--since must be YYYY-MM-DD, got ${since}`);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required");

  const supabase = createClient(url, key);
  const sinceIso = `${since}T00:00:00Z`;

  console.log(
    `dismiss-junk: ${apply ? "APPLY" : "dry run"}, floor ${floor} (match_score < ${floor}), created since ${since}, ` +
      `${includeHeuristic ? "Haiku and heuristic-only rows" : "Haiku-scored rows only"}`,
  );

  // Page through everything that qualifies. A null match_score never
  // qualifies: lt() excludes nulls, which is what we want for "unknown".
  const rows: JunkRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from("jobs")
      .select("id,user_id,source,match_score")
      .gte("created_at", sinceIso)
      .eq("status", "New")
      .is("date_applied", null)
      .is("dismissed_at", null)
      .lt("match_score", floor)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (!includeHeuristic) {
      query = query.not("score_reasoning", "is", null).neq("score_reasoning", "");
    }
    const { data, error } = await query;
    if (error) throw new Error(`could not load jobs: ${error.message}`);
    const page = (data ?? []) as JunkRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  console.log(`\n${rows.length} job${rows.length === 1 ? "" : "s"} qualify`);
  if (rows.length === 0) return;

  console.log("\nby source:");
  for (const [source, n] of countBy(rows, (r) => r.source || "(blank)")) {
    console.log(`  ${source.padEnd(12)} ${n}`);
  }
  console.log("\nby match_score:");
  for (const [score, n] of countBy(rows, (r) => String(r.match_score)).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  ${score.padEnd(12)} ${n}`);
  }
  console.log("\nby user (sha256 of user id, first 8):");
  for (const [user, n] of countBy(rows, (r) => shortUser(r.user_id))) {
    console.log(`  ${user.padEnd(12)} ${n}`);
  }

  if (!apply) {
    console.log("\ndry run: nothing written. Re-run with --apply to dismiss these rows.");
    return;
  }

  // Re-check the guards on every row inside the update, so a job the user
  // moved or dismissed between the read and the write is left alone.
  const dismissedAt = new Date().toISOString();
  let updated = 0;
  for (let i = 0; i < rows.length; i += UPDATE_CHUNK) {
    const ids = rows.slice(i, i + UPDATE_CHUNK).map((r) => r.id);
    const { data, error } = await supabase
      .from("jobs")
      .update({ dismissed_at: dismissedAt, dismiss_reason: DISMISS_REASON })
      .in("id", ids)
      .eq("status", "New")
      .is("date_applied", null)
      .is("dismissed_at", null)
      .lt("match_score", floor)
      .select("id");
    if (error) throw new Error(`update failed on chunk starting at ${i}: ${error.message}`);
    updated += (data ?? []).length;
  }
  console.log(`\ndismissed ${updated} of ${rows.length} rows (reason '${DISMISS_REASON}')`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
