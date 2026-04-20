-- Migration 002: Resume text + Gmail OAuth tokens

-- Add resume_text to profiles
alter table public.profiles
  add column if not exists resume_text text not null default '';

-- Gmail OAuth tokens per user
create table if not exists public.gmail_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles on delete cascade not null unique,
  access_token text not null,
  refresh_token text not null,
  token_expiry timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gmail_tokens enable row level security;

-- Only service role can read/write tokens (scraper + cron use service key)
create policy "Service role manages gmail tokens"
  on public.gmail_tokens for all using (true);

-- Index for fast user lookup
create index if not exists idx_gmail_tokens_user_id on public.gmail_tokens (user_id);
