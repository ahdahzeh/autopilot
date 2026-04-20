-- Migration 004: Tailoring intelligence — tone/model preferences, story bank, match reasoning

-- Tailoring preferences on profiles
alter table public.profiles
  add column if not exists tailoring_tone text not null default 'professional',
  add column if not exists tailoring_model text not null default 'sonnet';

-- Tailoring intelligence on jobs. Kept distinct from the existing
-- match_score (0-10 heuristic from the scraper) so the two signals don't
-- collide. tailor_score is 0-100 from the LLM's deeper analysis.
alter table public.jobs
  add column if not exists tailor_score integer,
  add column if not exists tailor_reasoning text not null default '';

-- Story bank: reusable accomplishments for tailoring
create table if not exists public.story_bank (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles on delete cascade not null,
  bullet_text text not null,
  original_resume_text text,
  source_job_id uuid references public.jobs on delete set null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_story_bank_user_id on public.story_bank (user_id, created_at desc);

alter table public.story_bank enable row level security;

create policy "Users can view own stories"
  on public.story_bank for select using (auth.uid() = user_id);
create policy "Users can insert own stories"
  on public.story_bank for insert with check (auth.uid() = user_id);
create policy "Users can update own stories"
  on public.story_bank for update using (auth.uid() = user_id);
create policy "Users can delete own stories"
  on public.story_bank for delete using (auth.uid() = user_id);
