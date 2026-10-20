/**
 * Daily ingest, run from GitHub Actions instead of Vercel cron.
 *
 * The Vercel cron path depends on a hosted Python scraper. That host was a
 * free tier, it was suspended for idling, and job ingest stopped dead on
 * 2026-06-10. The runner has no idle suspension, no 300s function ceiling and
 * no 512 MB memory limit, so the same work runs here with Chromium enabled.
 *
 * Ingest is sharded. The workflow runs SHARD_TOTAL copies of this script in
 * parallel jobs, each with its own scraper, and each copy keeps the users
 * whose stable hash lands on its SHARD_INDEX. The scraper serialises /scrape
 * behind a lock of one, so concurrency inside one job buys nothing: 17 users
 * took 48 to 54 minutes serially on 2026-10-16..19, and 60 would take about
 * 3 hours against GitHub's 6 hour job limit. More shards is the only lever.
 *
 * Expects the scraper to already be listening on RAILWAY_SCRAPER_URL (the
 * workflow starts it on 127.0.0.1:8000 in a previous step).
 *
 *   npx tsx scripts/ingest/run.ts                              # every user
 *   SHARD_INDEX=2 SHARD_TOTAL=4 npx tsx scripts/ingest/run.ts  # one shard
 *
 * The Actions log is public, because the repo is. Nothing here prints a user
 * id or anything the scraper returned beyond counts; users appear as the
 * 8-character hash that also decides their shard.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Agent, setGlobalDispatcher } from "undici";
import { scrapeForUser } from "../../src/lib/scrape";

// Node's fetch gives up on any response whose headers take longer than 300s,
// whatever AbortSignal the caller passes. A scrape routinely takes 3 minutes
// before the scraper sends a byte, so on 2026-10-16 16 of 17 requests died
// at 301s with a bare "fetch failed". Raise the ceiling to the scrape budget.
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS ?? 600_000);
setGlobalDispatcher(new Agent({ headersTimeout: SCRAPE_TIMEOUT_MS, bodyTimeout: SCRAPE_TIMEOUT_MS }));

// The scraper serialises /scrape behind a lock of one, so anything above 1
// only queues requests, and a queued request spends its timeout waiting. One
// that gives up stays in the scraper's queue anyway, pushing every later
// request further back.
const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 1);

/**
 * First 8 hex characters of sha1(user id). This is the user's label in the
 * public log and the key their shard is computed from, so a line in the log
 * says which shard owns the user without the id ever appearing. emails.ts
 * labels users the same way, so one grep finds a user in both jobs.
 */
function shortHash(id: string): string {
  return createHash("sha1").update(id).digest("hex").slice(0, 8);
}

/** Stable shard for a user: the 8 hex characters as an integer, modulo the shard count. */
function shardOf(id: string, total: number): number {
  return parseInt(shortHash(id), 16) % total;
}

/**
 * SHARD_INDEX / SHARD_TOTAL from the environment. Both default so a plain
 * `npx tsx scripts/ingest/run.ts` still scrapes everyone, and both are checked
 * strictly: a typo like SHARD_TOTAL=4 with SHARD_INDEX=4 would silently scrape
 * nobody, and that is exactly the failure that must not go green.
 */
function shardConfig(): { index: number; total: number } {
  const total = Number(process.env.SHARD_TOTAL ?? 1);
  const index = Number(process.env.SHARD_INDEX ?? 0);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`SHARD_TOTAL must be a positive integer, got "${process.env.SHARD_TOTAL}"`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(`SHARD_INDEX must be an integer from 0 to ${total - 1}, got "${process.env.SHARD_INDEX}"`);
  }
  return { index, total };
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Error and skip reasons are fixed strings today, but the scraper's response
 * is spread into the result, so anything it starts echoing back would reach
 * the public log through this one line. Hash any id that slips through.
 */
function redactIds(text: string): string {
  return text.replace(UUID_RE, (id) => shortHash(id.toLowerCase()));
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  if (!process.env.RAILWAY_SCRAPER_URL) throw new Error("RAILWAY_SCRAPER_URL is required");
  const shard = shardConfig();

  const supabase = createClient(url, key);
  const { data: users, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("onboarded", true);

  if (error) throw new Error(`could not load users: ${error.message}`);
  const everyone = (users ?? []).map((u) => u.id as string);

  // Sorted by hash so the order is the same on every runner, then rotated by
  // the day so a shard that hits its timeout does not strand the same tail of
  // users every day. The old Vercel cron shuffled for the same reason.
  const ids = everyone
    .filter((id) => shardOf(id, shard.total) === shard.index)
    .sort((a, b) => shortHash(a).localeCompare(shortHash(b)));
  if (ids.length > 1) {
    const offset = Math.floor(Date.now() / 86_400_000) % ids.length;
    ids.push(...ids.splice(0, offset));
  }
  console.log(
    `ingest: shard ${shard.index} of ${shard.total}: ${ids.length} of ${everyone.length} onboarded users, concurrency ${CONCURRENCY}`,
  );

  const results: Awaited<ReturnType<typeof scrapeForUser>>[] = [];
  // A plain worker pool, kept so concurrency can rise if the scraper's lock does.
  const queue = [...ids];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const started = Date.now();
      const result = await scrapeForUser(id);
      results.push(result);
      const label = result.error ? `error: ${result.error}` : result.skipped ? `skipped: ${result.reason}` : "ok";
      console.log(`  ${shortHash(id)} ${((Date.now() - started) / 1000).toFixed(1)}s ${redactIds(label)}`);
    }
  });
  await Promise.all(workers);

  const errored = results.filter((r) => r.error).length;
  const skipped = results.filter((r) => r.skipped).length;
  // The scraper reports what it wrote as jobs_added.
  const inserted = results.reduce((total, r) => total + (Number(r.jobs_added ?? 0) || 0), 0);
  console.log(
    `ingest done: shard ${shard.index} of ${shard.total}: ${results.length} users, ${inserted} jobs inserted, ${skipped} skipped, ${errored} errored`,
  );

  // Failing only when every user errored let 16 of 17 erroring go green. Most
  // users failing still means the scraper or the path to it is broken. This
  // is judged per shard, since each shard has its own scraper.
  if (results.length > 0 && errored * 2 > results.length) {
    throw new Error(`${errored} of ${results.length} users errored, failing the job so the run goes red`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
