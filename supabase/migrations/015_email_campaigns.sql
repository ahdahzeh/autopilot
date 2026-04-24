-- Email campaign tracking.
--
-- Two email streams share this schema:
--   1. Onboarding reminders  — profiles where onboarded=false, max 3 sends
--      on a day 1 / day 3 / day 7 cadence.
--   2. Engagement nudges      — profiles where onboarded=true, 1–2× per week
--      with a 3-day minimum gap between sends.
--
-- `emails_opted_out` is honored by both streams. `unsubscribe_token` gates
-- the public /api/emails/unsubscribe endpoint without requiring auth so
-- users can opt out directly from the email footer.

alter table public.profiles
  add column if not exists onboarding_reminder_count int not null default 0,
  add column if not exists onboarding_reminder_last_at timestamptz,
  add column if not exists engagement_email_last_at timestamptz,
  add column if not exists emails_opted_out boolean not null default false,
  add column if not exists unsubscribe_token text;

-- Backfill tokens for existing users. gen_random_uuid() is available via the
-- pgcrypto extension which Supabase enables by default.
update public.profiles
  set unsubscribe_token = replace(gen_random_uuid()::text, '-', '')
  where unsubscribe_token is null;

-- Enforce uniqueness + lookup speed after backfill.
create unique index if not exists idx_profiles_unsubscribe_token
  on public.profiles (unsubscribe_token)
  where unsubscribe_token is not null;

-- Default for any future rows.
alter table public.profiles
  alter column unsubscribe_token set default replace(gen_random_uuid()::text, '-', '');
