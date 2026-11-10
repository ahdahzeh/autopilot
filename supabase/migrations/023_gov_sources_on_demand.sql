-- Government job boards and on-demand scrapes (2026-11-10).
--
-- 1. on_demand_scrape_at: when the user last pressed "Run scrape now" (or
--    finished onboarding). The app starts a one-user GitHub Actions run and
--    uses this as a 20 minute cooldown (src/app/api/jobs/scrape/route.ts).
-- 2. Two new sources: 'nycjobs' (City of New York postings, only runs for New
--    York City targets) and 'usajobs' (federal postings, needs the USAJOBS
--    secrets). Both are added for every onboarded user who already runs any
--    source, since each one skips itself when it does not apply.
-- 3. The Per Scholas cohort codes carry the same sources in their preset.
--    KEEP IN SYNC with COHORT_SOURCES in src/lib/track-presets.ts.

alter table public.profiles
  add column if not exists on_demand_scrape_at timestamptz;

update public.profiles
   set sources = array_append(sources, 'nycjobs')
 where onboarded
   and coalesce(array_length(sources, 1), 0) > 0
   and not ('nycjobs' = any(sources));

update public.profiles
   set sources = array_append(sources, 'usajobs')
 where onboarded
   and coalesce(array_length(sources, 1), 0) > 0
   and not ('usajobs' = any(sources));

update public.invite_codes
   set prefilled_profile = jsonb_set(
         prefilled_profile,
         '{sources}',
         '["hiringcafe", "builtin", "greenhouse", "lever", "ashby", "workday", "nycjobs", "usajobs", "linkedin"]'::jsonb
       )
 where code in ('PSNY-IT', 'PSNY-CYBER', 'PSNY-DATA')
   and prefilled_profile ? 'sources';
