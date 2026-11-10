@AGENTS.md

## Project state (refreshed 2026-11-10)

Autopilot is a job-search product at autopilot.ahdahzeh.com: users onboard (often by invite code), the system ingests and scores jobs for each of them daily, and emails them digests. Next.js on Vercel, Supabase backend, GitHub `ahdahzeh/autopilot` (public repo).

**Daily ingest runs on GitHub Actions, not Vercel** (since 2026-10-16; sharded 2026-10-20). `.github/workflows/ingest.yml`: `plan` turns the shard count into a matrix, N `ingest` shards each start the Python scraper on the runner and scrape the users whose id hashes to their index (`scripts/ingest/run.ts`), then `emails` runs after every shard (`scripts/ingest/emails.ts`: Gmail sync, onboarding reminders, engagement nudges, daily digest). Cron is 09:23 UTC; GitHub delays it, so runs usually land 15:00-20:00 UTC. The old Railway/Render hosted scraper is dead; the Vercel cron is a no-op.
- Diagnose with `gh run list --workflow=ingest.yml` and by counting `jobs` rows by `created_at`. A green run is not enough: check rows landed.
- Node fetch dies at 300s whatever the AbortSignal says; `run.ts` sets an undici dispatcher.
- 8 shards by default (2026-11-10). Each source over-fetches (`max(15, 2 x daily limit)`, `PER_SOURCE_MIN`/`PER_SOURCE_FACTOR` in scraper/main.py); the daily limit applies once after dedup and filters. Before, every source was capped at 5 and users got 3-7 a day. LinkedIn runs 14 searches x 8 reads.
- A `Source summary` step prints per-source counts every run (counts only; safe in the public log). Read it first when yield drops.
- **On-demand scrapes** (Settings "Run scrape now", the scrape fired at the end of onboarding, admin rescan) start a one-user run of the same workflow: `src/lib/dispatch-ingest.ts`, workflow input `user` = first 8 hex of sha1(user id), own concurrency group, emails skipped, 20 min cooldown (`profiles.on_demand_scrape_at`, 023). Needs `GITHUB_DISPATCH_TOKEN` in Vercel (fine-grained, Actions read/write on this repo); without it the route answers "tomorrow morning". The Railway URL in Vercel env is dead and unused.
- Repo secrets set: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (2026-11-10). **Missing:** `USAJOBS_API_KEY`, `USAJOBS_EMAIL`.
- Apply migrations with `npx supabase db query --linked --project-ref ywimougyppyxbsnbvtna --yes -f <file>` (agent mode needs `--yes`; wrap the file in begin/commit).
- Vercel Preview builds fail: Supabase/Anthropic env vars only exist in Production.

**Sources:** HiringCafe (Cloudflare challenges GitHub's runners since 2026-11-07; on a challenge it reads through headless Chromium), BuiltIn, LinkedIn (Remote means US-remote), Workday career sites (migration 019), NYC Jobs (City of New York open data, NYC targets only, strict title match), USAJOBS (federal; skips until its secrets exist), with a global score floor. India listings are blocked for every user and source. Parallel (parallel.ai) is not a search source: its index lags fast-closing postings; it is only worth it for reading pages that block us.

**Users and money:** multi-use invite codes redeemed server side (020, admins mint them); tailoring capped at 20/day with token usage logged, extra tailors sold through Stripe (021); users can mark "I got a job" to pause their search (022). Migrations are numbered; check `supabase/migrations/` before naming one.

**Known issue (2026-11-04):** the daily digest had never sent: its jobs query asked for `jobs.title` (the column is `role`) and dropped the error. Fixed by PR #2 (merged 2026-11-09); the first run after that is the first digest ever sent.

**Monitoring:** the local `autopilot-ingest-watch` scheduled task checks every run and new-job counts daily at 15:00 and writes `~/Documents/ops-reports/autopilot-ingest/YYYY-MM-DD.md`.


## Session Checkpoint — 2026-05-18

**Shipped:**
- LinkedIn post finalized — accurate description of current Autopilot (9 outputs, Claude Agent SDK, SSE streaming, 90s turnaround)
- Post audited with /avoid-ai-writing skill — clean, no rewrites needed beyond "fresh" cut

**Next:**
- HyperFrames video for autopilot.ahdahzeh.com (interrupted mid-build)
- Had read: globals.css, visual-styles.md, transitions.md, house-style.md — ready to write DESIGN.md and index.html
- Narrative: glassmorphism button → expands to prompt box → 9 output cards unfold → combine into video player → loop

**Don't repeat:**
- `~/job-autopilot/` is the OLD Python script (has Notion + ReportLab) — NOT what the site is. Don't describe the site using those details.
- `~/Documents/Scour-autopilot` does not exist — the web app lives at `~/Documents/Scour/autopilot`

**Decisions locked:**
- HyperFrames video style: glassmorphism on morphing dark backgrounds (custom style, not a named preset)
- Design tokens from globals.css: gold `#f5a623`, Vercel blue `#1f51ff`, green `#00cc55`, bg `#0a0a0a` (dark), Geist Sans + Geist Mono
