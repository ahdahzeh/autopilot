-- "I got a job": a user who has landed a role pauses their search.
--
-- hired_at set means the daily ingest skips them (scripts/ingest/run.ts and
-- src/lib/scrape.ts) and the engagement nudges and daily digest stop
-- (src/lib/email-campaigns.ts). Clearing it resumes everything. Nothing is
-- deleted, so their tracker and history stay put.
alter table public.profiles
  add column if not exists hired_at timestamptz,
  add column if not exists hired_company text;
