-- 020: Multi-use invite codes, redeemed server side.
--
-- Until now a code was single-use (used_by) and the browser did the claiming:
-- signup selected the row under "Anyone can read invite code by code value",
-- wrote used_by itself, then copied prefilled_profile onto the new profile.
-- Two things made that wrong for a cohort. Any anon client could read every
-- live code's prefilled_profile, and two signups racing on one code both won.
-- About 30 Per Scholas NY graduates join in 2026-10 on three shared codes,
-- one per track, so a code now carries max_uses/use_count and the
-- check-and-claim moves into redeem_invite_code(), which runs as the table
-- owner and locks the code row.

-- ── 1. Code capacity and bookkeeping ─────────────────────────────────────
-- max_uses defaults to 1 so every existing code keeps its single-use
-- behaviour. active lets an admin close a code early without deleting it.
alter table public.invite_codes
  add column if not exists max_uses integer not null default 1,
  add column if not exists use_count integer not null default 0,
  add column if not exists label text not null default '',
  add column if not exists active boolean not null default true;

alter table public.invite_codes drop constraint if exists invite_codes_max_uses_check;
alter table public.invite_codes add constraint invite_codes_max_uses_check check (max_uses >= 1);
alter table public.invite_codes drop constraint if exists invite_codes_use_count_check;
alter table public.invite_codes add constraint invite_codes_use_count_check check (use_count >= 0);

-- ── 2. One row per redemption ────────────────────────────────────────────
-- The unique (code_id, user_id) pair is what makes redeem_invite_code()
-- idempotent per user: a double submit or a retried signup counts once.
create table if not exists public.invite_redemptions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references public.invite_codes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  constraint invite_redemptions_code_user_key unique (code_id, user_id)
);

create index if not exists idx_invite_redemptions_user on public.invite_redemptions (user_id);

alter table public.invite_redemptions enable row level security;

-- Redeemers see their own rows; code creators see who used their codes.
-- Only redeem_invite_code() writes rows, so clients get no insert, update
-- or delete policy at all.
drop policy if exists "Users can view own redemptions" on public.invite_redemptions;
create policy "Users can view own redemptions"
  on public.invite_redemptions for select
  using (auth.uid() = user_id);

drop policy if exists "Code creators can view redemptions of their codes" on public.invite_redemptions;
create policy "Code creators can view redemptions of their codes"
  on public.invite_redemptions for select
  using (
    exists (
      select 1 from public.invite_codes c
      where c.id = invite_redemptions.code_id and c.created_by = auth.uid()
    )
  );

-- Backfill: codes claimed under the old flow count as one redemption, so a
-- max_uses=1 code that was used stays closed. We never recorded when the
-- claim happened; the code's created_at is within a week of it (codes
-- expired after 7 days), which beats stamping the migration time.
insert into public.invite_redemptions (code_id, user_id, redeemed_at)
  select id, used_by, created_at
    from public.invite_codes
   where used_by is not null
  on conflict (code_id, user_id) do nothing;

update public.invite_codes
   set use_count = 1
 where used_by is not null and use_count = 0;

-- ── 3. Policies on invite_codes ──────────────────────────────────────────
-- The browser no longer reads or claims codes directly, so the two
-- permissive policies from 001 go. Minting and editing codes is admin-only;
-- the old insert policy let any signed-in user create codes for themselves.
drop policy if exists "Anyone can read invite code by code value" on public.invite_codes;
drop policy if exists "Users can claim invite codes" on public.invite_codes;

drop policy if exists "Admins can insert invite codes" on public.invite_codes;
create policy "Admins can insert invite codes"
  on public.invite_codes for insert
  with check (
    auth.uid() = created_by
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "Admins can update own invite codes" on public.invite_codes;
create policy "Admins can update own invite codes"
  on public.invite_codes for update
  using (
    auth.uid() = created_by
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  )
  with check (auth.uid() = created_by);

-- ── 4. Prefill helpers ───────────────────────────────────────────────────
-- prefilled_profile is admin-authored JSON. Each helper returns null when
-- the key is missing or the wrong shape, so coalesce() keeps the profile's
-- current value instead of failing the whole redemption.
create or replace function public.invite_prefill_text_array(v jsonb)
returns text[]
language sql
immutable
as $$
  select case
    when jsonb_typeof(v) = 'array' then array(select jsonb_array_elements_text(v))
  end
$$;

create or replace function public.invite_prefill_int(v jsonb)
returns integer
language sql
immutable
as $$
  select case
    when jsonb_typeof(v) = 'number' then round((v #>> '{}')::numeric)::integer
  end
$$;

-- The whitelist of profile columns a prefill may set, and the keys of the
-- given prefill that redeem_invite_code() will actually apply: a whitelisted
-- key whose value has the wrong shape (a string where an array belongs) is
-- left out here exactly as the redemption leaves the column alone. Anything
-- else in the JSON (is_admin, say) is ignored. Onboarding reads this list
-- back through my_invite_redemption() to decide which steps the invite
-- already answered, so it must never name a field that was not written.
create or replace function public.invite_prefilled_fields(p jsonb)
returns text[]
language sql
immutable
as $$
  select case
    when jsonb_typeof(p) = 'object' then array(
      select k from jsonb_object_keys(p) k
       where (
           k in (
             'target_titles', 'target_locations', 'sources',
             'priority_industries', 'priority_keywords',
             'excluded_titles', 'excluded_companies'
           ) and jsonb_typeof(p->k) = 'array'
         ) or (
           k in ('salary_floor', 'daily_job_limit', 'min_match_score')
           and jsonb_typeof(p->k) = 'number'
         ) or (
           k = 'role_family' and jsonb_typeof(p->k) = 'string'
         )
       order by k
    )
    else '{}'::text[]
  end
$$;

-- ── 5. check_invite_code: what signup may learn before an account exists ─
-- Only validity and the label. Never prefilled_profile, the counts, or who
-- redeemed it. Callable by anon because signup runs before there is a user.
create or replace function public.check_invite_code(code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object('valid', true, 'label', nullif(c.label, ''))
        from public.invite_codes c
       where c.code = upper(trim(check_invite_code.code))
         and c.active
         and c.expires_at > now()
         and c.use_count < c.max_uses
    ),
    jsonb_build_object('valid', false, 'label', null)
  )
$$;

revoke all on function public.check_invite_code(text) from public;
grant execute on function public.check_invite_code(text) to anon, authenticated, service_role;

-- ── 6. redeem_invite_code: the atomic claim ──────────────────────────────
-- Locks the code row so two members racing for the last slot cannot both
-- pass the use_count check, records the redemption once per user, bumps
-- use_count, and copies the whitelisted prefilled_profile keys onto the
-- caller's profile. Returns {ok, label, prefilled_fields} or {ok, reason}.
create or replace function public.redeem_invite_code(code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  c public.invite_codes%rowtype;
  p jsonb;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;

  select * into c
    from public.invite_codes i
   where i.code = upper(trim(redeem_invite_code.code))
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Same user again: report success without counting a second use.
  if exists (
    select 1 from public.invite_redemptions r
     where r.code_id = c.id and r.user_id = uid
  ) then
    return jsonb_build_object(
      'ok', true,
      'label', nullif(c.label, ''),
      'prefilled_fields', to_jsonb(public.invite_prefilled_fields(c.prefilled_profile)),
      'already_redeemed', true
    );
  end if;

  if not c.active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  if c.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if c.use_count >= c.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'exhausted');
  end if;

  insert into public.invite_redemptions (code_id, user_id) values (c.id, uid);

  update public.invite_codes
     set use_count = use_count + 1,
         -- used_by keeps its old meaning for single-use codes so anything
         -- still reading it sees the same answer as before.
         used_by = case when max_uses = 1 then uid else used_by end
   where id = c.id;

  -- Apply the prefill. Keys must match invite_prefilled_fields() above.
  p := c.prefilled_profile;
  if p is not null and jsonb_typeof(p) = 'object' then
    update public.profiles set
      target_titles       = coalesce(public.invite_prefill_text_array(p->'target_titles'), target_titles),
      target_locations    = coalesce(public.invite_prefill_text_array(p->'target_locations'), target_locations),
      sources             = coalesce(public.invite_prefill_text_array(p->'sources'), sources),
      priority_industries = coalesce(public.invite_prefill_text_array(p->'priority_industries'), priority_industries),
      priority_keywords   = coalesce(public.invite_prefill_text_array(p->'priority_keywords'), priority_keywords),
      excluded_titles     = coalesce(public.invite_prefill_text_array(p->'excluded_titles'), excluded_titles),
      excluded_companies  = coalesce(public.invite_prefill_text_array(p->'excluded_companies'), excluded_companies),
      salary_floor        = coalesce(public.invite_prefill_int(p->'salary_floor'), salary_floor),
      daily_job_limit     = coalesce(public.invite_prefill_int(p->'daily_job_limit'), daily_job_limit),
      min_match_score     = coalesce(public.invite_prefill_int(p->'min_match_score'), min_match_score),
      role_family         = coalesce(
                              case when jsonb_typeof(p->'role_family') = 'string' then p->>'role_family' end,
                              role_family
                            )
    where id = uid;
  end if;

  return jsonb_build_object(
    'ok', true,
    'label', nullif(c.label, ''),
    'prefilled_fields', to_jsonb(public.invite_prefilled_fields(p))
  );
end;
$$;

revoke all on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated, service_role;

-- ── 7. my_invite_redemption: what onboarding needs to skip steps ─────────
-- The caller's most recent redemption as {code, label, prefilled_fields,
-- redeemed_at}, or null. Users cannot read invite_codes themselves (the
-- creator-only select policy stays), so this is the one window onto the
-- code they used, and it exposes nothing about other redeemers.
create or replace function public.my_invite_redemption()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'code', c.code,
           'label', nullif(c.label, ''),
           'prefilled_fields', to_jsonb(public.invite_prefilled_fields(c.prefilled_profile)),
           'redeemed_at', r.redeemed_at
         )
    from public.invite_redemptions r
    join public.invite_codes c on c.id = r.code_id
   where r.user_id = auth.uid()
   order by r.redeemed_at desc
   limit 1
$$;

revoke all on function public.my_invite_redemption() from public, anon;
grant execute on function public.my_invite_redemption() to authenticated, service_role;

-- ── 8. Per Scholas NY cohort codes ───────────────────────────────────────
-- KEEP IN SYNC with TRACK_PRESETS in src/lib/track-presets.ts. These three
-- prefilled_profile objects mirror the TypeScript presets key for key and
-- value for value; change a title in one place and change it in the other
-- in the same commit. created_by is the earliest admin profile. On a
-- database with no admin yet the seed is skipped with a notice so the rest
-- of the migration still applies; rerun this block once an admin exists.
-- on conflict do nothing: an admin may have edited these rows in Settings
-- (bumped max_uses, closed a code) and a rerun must not undo that.
do $seed$
declare
  admin_id uuid;
  -- Valid through the end of 2027-03-31 in New York, where the cohort is.
  cohort_expiry timestamptz := timestamptz '2027-04-01 00:00:00 America/New_York';
begin
  select id into admin_id
    from public.profiles
   where is_admin
   order by created_at asc, id asc
   limit 1;

  if admin_id is null then
    raise notice 'No admin profile yet; skipping the Per Scholas NY invite codes';
    return;
  end if;

  insert into public.invite_codes (code, created_by, label, max_uses, expires_at, prefilled_profile)
  values
    (
      'PSNY-IT', admin_id, 'AI-Enabled Healthcare IT Technician', 60, cohort_expiry,
      '{
        "role_family": "other",
        "target_titles": [
          "IT Support Specialist", "Help Desk Technician", "Service Desk Analyst",
          "Desktop Support Technician", "Healthcare IT Support Specialist",
          "EHR Support Analyst", "Technical Support Specialist", "IT Technician"
        ],
        "target_locations": ["New York, NY", "Remote"],
        "salary_floor": 0,
        "daily_job_limit": 20,
        "sources": ["hiringcafe", "builtin", "greenhouse", "lever", "ashby", "workday", "linkedin"],
        "priority_industries": ["Healthcare", "Hospitals and health systems", "Health IT", "Managed IT services"],
        "excluded_titles": ["senior", "sr.", "lead", "principal", "staff", "manager", "director", "head of", "chief", "vice president", "architect"]
      }'::jsonb
    ),
    (
      'PSNY-CYBER', admin_id, 'Cybersecurity with AI Tools', 60, cohort_expiry,
      '{
        "role_family": "other",
        "target_titles": [
          "SOC Analyst", "Junior Cybersecurity Analyst", "Information Security Analyst",
          "Cybersecurity Analyst", "Security Operations Analyst", "IT Security Specialist",
          "GRC Analyst", "Vulnerability Management Analyst"
        ],
        "target_locations": ["New York, NY", "Remote"],
        "salary_floor": 0,
        "daily_job_limit": 20,
        "sources": ["hiringcafe", "builtin", "greenhouse", "lever", "ashby", "workday", "linkedin"],
        "priority_industries": ["Cybersecurity", "Financial services", "Healthcare", "Managed security services", "Government and public sector"],
        "excluded_titles": ["senior", "sr.", "lead", "principal", "staff", "manager", "director", "head of", "chief", "vice president", "architect"]
      }'::jsonb
    ),
    (
      'PSNY-DATA', admin_id, 'AI-Native Business Intelligence', 60, cohort_expiry,
      '{
        "role_family": "data",
        "target_titles": [
          "Business Intelligence Analyst", "Data Analyst", "Junior Data Analyst",
          "Reporting Analyst", "BI Developer", "Power BI Developer",
          "Data Analytics Associate", "SQL Analyst"
        ],
        "target_locations": ["New York, NY", "Remote"],
        "salary_floor": 0,
        "daily_job_limit": 20,
        "sources": ["hiringcafe", "builtin", "greenhouse", "lever", "ashby", "workday", "linkedin"],
        "priority_industries": ["Financial services", "Healthcare", "Retail and e-commerce", "Media", "Technology"],
        "excluded_titles": ["senior", "sr.", "lead", "principal", "staff", "manager", "director", "head of", "chief", "vice president", "architect"]
      }'::jsonb
    )
  on conflict (code) do nothing;
end
$seed$;
