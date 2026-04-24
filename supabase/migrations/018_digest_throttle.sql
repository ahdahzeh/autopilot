alter table public.profiles
  add column if not exists digest_email_last_at timestamptz;
