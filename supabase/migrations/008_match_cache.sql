-- Cached match scores keyed by (resume_hash, job_id).
-- A match block is the most-called LLM operation in the app: every time the
-- user reopens a job's tailor modal it would otherwise recompute. Since the
-- inputs (resume + job description) are immutable per resume version, we
-- cache the full match JSON and serve it instantly on hit.

create table if not exists public.match_cache (
  resume_hash text not null,
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (resume_hash, job_id)
);

alter table public.match_cache enable row level security;

drop policy if exists "match_cache self read" on public.match_cache;
create policy "match_cache self read"
  on public.match_cache for select
  using (auth.uid() = user_id);

drop policy if exists "match_cache self write" on public.match_cache;
create policy "match_cache self write"
  on public.match_cache for insert
  with check (auth.uid() = user_id);

drop policy if exists "match_cache self update" on public.match_cache;
create policy "match_cache self update"
  on public.match_cache for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists match_cache_user_idx on public.match_cache (user_id);
create index if not exists match_cache_job_idx on public.match_cache (job_id);
