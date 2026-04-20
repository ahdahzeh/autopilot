-- Per-user daily tailor invocation counter. One row per (user_id, day).
-- Used by /api/tailor to enforce DAILY_LIMIT and keep the shared Anthropic
-- key from getting hammered when we open signup to a wider audience.

create table if not exists public.tailor_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.tailor_usage enable row level security;

drop policy if exists "tailor_usage self read" on public.tailor_usage;
create policy "tailor_usage self read"
  on public.tailor_usage for select
  using (auth.uid() = user_id);

drop policy if exists "tailor_usage self upsert" on public.tailor_usage;
create policy "tailor_usage self upsert"
  on public.tailor_usage for insert
  with check (auth.uid() = user_id);

drop policy if exists "tailor_usage self update" on public.tailor_usage;
create policy "tailor_usage self update"
  on public.tailor_usage for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists tailor_usage_day_idx on public.tailor_usage (day);
