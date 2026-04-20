-- Migration 005: Persist scraped job description text
-- Lets the tailor modal prefill the JD textarea so the user just hits Generate
-- instead of pasting it back from the source listing.

alter table public.jobs
  add column if not exists description text not null default '';
