-- Autopilot v3: Multi-user schema

-- Profiles (extends Supabase auth.users)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null default '',
  target_titles text[] not null default '{}',
  target_locations text[] not null default '{}',
  salary_floor integer not null default 0,
  excluded_companies text[] not null default '{}',
  priority_industries text[] not null default '{}',
  priority_keywords text[] not null default '{}',
  sources text[] not null default '{"linkedin", "builtin"}',
  daily_job_limit integer not null default 20,
  gmail_connected boolean not null default false,
  is_admin boolean not null default false,
  onboarded boolean not null default false,
  created_at timestamptz not null default now()
);

-- Jobs
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles on delete cascade not null,
  company text not null default '',
  role text not null default '',
  location text not null default '',
  industry text not null default '',
  company_size text not null default '',
  source text not null default '',
  source_url text not null default '',
  apply_link text not null default '',
  salary_range text not null default '',
  match_score integer,
  priority text not null default 'Medium',
  status text not null default 'New',
  outcome text not null default '',
  founding_role boolean not null default false,
  date_found date default current_date,
  date_applied date,
  response_date date,
  dismissed_at timestamptz,
  dismiss_reason text,
  manually_added boolean not null default false,
  created_at timestamptz not null default now(),
  dedup_hash text not null default ''
);

-- Invite codes
create table public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  created_by uuid references public.profiles not null,
  used_by uuid references public.profiles,
  prefilled_profile jsonb,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

-- Indexes
create index idx_jobs_user_id on public.jobs (user_id);
create index idx_jobs_status on public.jobs (user_id, status);
create index idx_jobs_dedup on public.jobs (user_id, dedup_hash);
create index idx_jobs_date_found on public.jobs (user_id, date_found desc);
create index idx_invite_codes_code on public.invite_codes (code);

-- Row-Level Security
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.invite_codes enable row level security;

-- Profiles: users can read/update their own profile
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);
create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

-- Jobs: users can only access their own jobs
create policy "Users can view own jobs"
  on public.jobs for select using (auth.uid() = user_id);
create policy "Users can insert own jobs"
  on public.jobs for insert with check (auth.uid() = user_id);
create policy "Users can update own jobs"
  on public.jobs for update using (auth.uid() = user_id);
create policy "Users can delete own jobs"
  on public.jobs for delete using (auth.uid() = user_id);

-- Invite codes: admins can manage their own codes, anyone can read by code for redemption
create policy "Admins can view own invite codes"
  on public.invite_codes for select using (auth.uid() = created_by);
create policy "Admins can insert invite codes"
  on public.invite_codes for insert with check (auth.uid() = created_by);
create policy "Anyone can read invite code by code value"
  on public.invite_codes for select using (used_by is null and expires_at > now());
create policy "Users can claim invite codes"
  on public.invite_codes for update using (used_by is null and expires_at > now());

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Service role bypass for scraper inserts
create policy "Service role can insert jobs"
  on public.jobs for insert with check (true);
create policy "Service role can read all profiles"
  on public.profiles for select using (true);
