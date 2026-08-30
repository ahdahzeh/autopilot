/**
 * Daily ingest, run from GitHub Actions instead of Vercel cron.
 *
 * The Vercel cron path depends on a hosted Python scraper. That host was a
 * free tier, it was suspended for idling, and job ingest stopped dead on
 * 2026-06-10. The runner has no idle suspension, no 300s function ceiling and
 * no 512 MB memory limit, so the same work runs here with Chromium enabled.
 *
 * Expects the scraper to already be listening on RAILWAY_SCRAPER_URL (the
 * workflow starts it on 127.0.0.1:8000 in a previous step).
 *
 *   npx tsx scripts/ingest/run.ts
 */
import { createClient } from "@supabase/supabase-js";
import { scrapeForUser } from "../../src/lib/scrape";

const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 3);

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  if (!process.env.RAILWAY_SCRAPER_URL) throw new Error("RAILWAY_SCRAPER_URL is required");

  const supabase = createClient(url, key);
  const { data: users, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("onboarded", true);

  if (error) throw new Error(`could not load users: ${error.message}`);
  const ids = (users ?? []).map((u) => u.id as string);
  console.log(`ingest: ${ids.length} onboarded users, concurrency ${CONCURRENCY}`);

  const results: Awaited<ReturnType<typeof scrapeForUser>>[] = [];
  // A plain worker pool. The Python service serialises /scrape behind its own
  // semaphore, so this only controls how many requests are queued at once.
  const queue = [...ids];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const started = Date.now();
      const result = await scrapeForUser(id);
      results.push(result);
      const label = result.error ? `error: ${result.error}` : result.skipped ? `skipped: ${result.reason}` : "ok";
      console.log(`  ${id} ${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);
    }
  });
  await Promise.all(workers);

  const errored = results.filter((r) => r.error).length;
  const skipped = results.filter((r) => r.skipped).length;
  const inserted = results.reduce((total, r) => total + (Number(r.inserted ?? 0) || 0), 0);
  console.log(`ingest done: ${results.length} users, ${inserted} jobs inserted, ${skipped} skipped, ${errored} errored`);

  // A run where every single user errored means the scraper is unreachable or
  // broken, which is exactly the silent failure that went unnoticed for weeks.
  if (results.length > 0 && errored === results.length) {
    throw new Error("every user errored, failing the job so the run goes red");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
