-- 023: close three policies that were written for the service role but apply
-- to everyone, and stop a user making themselves admin.
--
-- 001 and 002 created "Service role ..." policies with no role named. A policy
-- with no TO clause applies to every role, anon included, and the service role
-- bypasses row level security anyway, so these never did anything for it. What
-- they did do, checked against production on 2026-11-09 with the public anon
-- key: every profiles row (resumes included) and every gmail_tokens row was
-- readable, and gmail_tokens was writable, by anyone holding the key that ships
-- in the site's JavaScript.
--
-- Every server path that needs all rows already uses the service client
-- (admin page, gmail sync and draft, the scraper, the ingest scripts). Users
-- keep their own-row policies from 001.
--
-- Safe to run twice.

drop policy if exists "Service role can read all profiles" on public.profiles;
drop policy if exists "Service role manages gmail tokens" on public.gmail_tokens;
drop policy if exists "Service role can insert jobs" on public.jobs;

-- "Users can update own profile" has no column list, so a signed-in user could
-- PATCH is_admin on their own row and open /admin. Only the service role (and
-- the SQL editor, which has no request role) may change it.
create or replace function public.protect_profile_admin_flag()
returns trigger
language plpgsql
as $$
begin
  if new.is_admin is distinct from old.is_admin
     and coalesce(auth.role(), 'postgres') in ('anon', 'authenticated') then
    raise exception 'is_admin can only be changed by an administrator';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_admin_flag on public.profiles;
create trigger protect_profile_admin_flag
  before update on public.profiles
  for each row execute function public.protect_profile_admin_flag();

-- After running, both of these should return no rows when called with the anon
-- key and no session:
--   GET /rest/v1/profiles?select=id
--   GET /rest/v1/gmail_tokens?select=user_id
