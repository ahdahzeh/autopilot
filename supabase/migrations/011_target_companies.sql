-- Target companies for direct ATS scraping (Greenhouse / Lever / Ashby).
-- Unlike search-based sources (LinkedIn/BuiltIn), ATS endpoints are per-company,
-- so we need a list. Rows with user_id IS NULL are global seed companies scraped
-- for every user; rows with a user_id are that user's personal additions.

create table if not exists public.target_companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles on delete cascade,
  ats_type text not null check (ats_type in ('greenhouse', 'lever', 'ashby')),
  slug text not null,
  name text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  -- NULLS NOT DISTINCT so global seed rows (user_id IS NULL) dedupe properly
  -- on re-runs. Supabase is on Postgres 15+, which supports this syntax.
  constraint target_companies_user_ats_slug_key
    unique nulls not distinct (user_id, ats_type, slug)
);

create index if not exists idx_target_companies_user on public.target_companies (user_id) where active;
create index if not exists idx_target_companies_global on public.target_companies (ats_type) where user_id is null and active;

alter table public.target_companies enable row level security;

-- Users can see: their own rows + global rows (user_id IS NULL).
drop policy if exists "target_companies read own or global" on public.target_companies;
create policy "target_companies read own or global"
  on public.target_companies for select
  using (user_id is null or auth.uid() = user_id);

-- Users can add/update/delete only their own rows. Service role bypasses RLS
-- and manages the global seed list via migrations or an admin script.
drop policy if exists "target_companies insert own" on public.target_companies;
create policy "target_companies insert own"
  on public.target_companies for insert
  with check (auth.uid() = user_id);

drop policy if exists "target_companies update own" on public.target_companies;
create policy "target_companies update own"
  on public.target_companies for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "target_companies delete own" on public.target_companies;
create policy "target_companies delete own"
  on public.target_companies for delete
  using (auth.uid() = user_id);
