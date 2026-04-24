-- Haiku semantic scoring fields.
-- Populated by the Railway scraper after the cheap heuristic filter, for the
-- top candidates per scrape. All three are nullable — older rows may have
-- only the heuristic match_score, and the UI falls back to that.
--
-- score_reasoning  — one-sentence "why this fits", shown on the action card
-- matched_skills   — 3-ish resume skills that align with the JD, rendered as chips
-- concerns         — dealbreakers or flags ("SF only", "founding role"), shown in modal

alter table public.jobs
  add column if not exists score_reasoning text,
  add column if not exists matched_skills text[],
  add column if not exists concerns text[];
