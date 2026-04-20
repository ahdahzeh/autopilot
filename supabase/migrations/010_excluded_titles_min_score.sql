-- Per-user title exclusions and minimum match score gate.
-- excluded_titles: substring matches dropped before insert (case-insensitive).
-- min_match_score: jobs scoring below this on the 0-10 scale are not inserted.

alter table public.profiles
  add column if not exists excluded_titles text[] not null default '{}',
  add column if not exists min_match_score integer not null default 0;
