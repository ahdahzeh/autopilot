-- Yield + feedback + digest improvements.
--
-- - expanded_titles:       title variants produced by Haiku from target_titles (scraper joins both)
-- - years_experience:      parsed from resume once; drives seniority-aware title expansion
-- - resume_depth_score:    0-100 meta-audit — surfaced as a settings nudge when < 70
-- - resume_depth_issues:   short strings like "no project scope", "no metrics"
-- - priority_industries/_keywords already exist — no change here
--
-- - job_feedback:          "Not a fit" signals, joined into the Haiku prompt next scrape
-- - source_stats:          per-scrape yield per source, for yield-gap diagnostics
-- - vertical_packs:        curated sets of target_companies slugs grouped by vertical
--                          (fintech, health, climate, etc.) users subscribe to at onboarding

alter table public.profiles
  add column if not exists expanded_titles text[] default '{}',
  add column if not exists years_experience integer,
  add column if not exists resume_depth_score integer,
  add column if not exists resume_depth_issues text[] default '{}';

-- ── job_feedback ──────────────────────────────────────────────────────────
create table if not exists public.job_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  feedback_type text not null check (feedback_type in ('not_a_fit', 'wrong_seniority', 'wrong_industry', 'wrong_location', 'spam')),
  company text,
  role text,
  created_at timestamptz not null default now(),
  constraint job_feedback_user_job_unique unique (user_id, job_id, feedback_type)
);
create index if not exists idx_job_feedback_user_recent on public.job_feedback (user_id, created_at desc);

alter table public.job_feedback enable row level security;
drop policy if exists "job_feedback read own" on public.job_feedback;
create policy "job_feedback read own"
  on public.job_feedback for select using (auth.uid() = user_id);
drop policy if exists "job_feedback insert own" on public.job_feedback;
create policy "job_feedback insert own"
  on public.job_feedback for insert with check (auth.uid() = user_id);
drop policy if exists "job_feedback delete own" on public.job_feedback;
create policy "job_feedback delete own"
  on public.job_feedback for delete using (auth.uid() = user_id);

-- ── source_stats ──────────────────────────────────────────────────────────
-- Append-only log of how many jobs each source produced per scrape. Simple
-- view/admin dashboard consumes this. No RLS — service-role only.
create table if not exists public.source_stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  scraped_at timestamptz not null default now(),
  source text not null,
  jobs_returned integer not null default 0,
  jobs_after_dedup integer not null default 0,
  jobs_inserted integer not null default 0,
  error text
);
create index if not exists idx_source_stats_time on public.source_stats (scraped_at desc);
create index if not exists idx_source_stats_source_time on public.source_stats (source, scraped_at desc);

alter table public.source_stats enable row level security;
-- Users can read their own rows (for the dashboard); service role writes.
drop policy if exists "source_stats read own" on public.source_stats;
create policy "source_stats read own"
  on public.source_stats for select using (auth.uid() = user_id);

-- ── vertical_packs ────────────────────────────────────────────────────────
-- One row per curated vertical → maps to a set of target_companies slugs.
-- When a user subscribes in onboarding, we upsert those slugs into their
-- target_companies rows with user_id=<them>. Global seeds (user_id IS NULL)
-- still run for everyone; packs are an opt-in signal boost per vertical.
create table if not exists public.vertical_packs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,            -- 'fintech', 'health', 'climate', 'consumer', 'b2b-saas'
  name text not null,                   -- 'Fintech', 'Health & Bio', 'Climate', ...
  description text not null default '',
  icon text,                            -- optional emoji for onboarding UI
  ats_slugs jsonb not null default '[]',-- array of {ats_type, slug, name}
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.vertical_packs enable row level security;
drop policy if exists "vertical_packs read all" on public.vertical_packs;
create policy "vertical_packs read all"
  on public.vertical_packs for select using (true);

-- Track which packs a user subscribed to (so we can re-sync if pack contents change).
create table if not exists public.profile_verticals (
  user_id uuid not null references public.profiles(id) on delete cascade,
  vertical_pack_id uuid not null references public.vertical_packs(id) on delete cascade,
  subscribed_at timestamptz not null default now(),
  primary key (user_id, vertical_pack_id)
);
alter table public.profile_verticals enable row level security;
drop policy if exists "profile_verticals read own" on public.profile_verticals;
create policy "profile_verticals read own"
  on public.profile_verticals for select using (auth.uid() = user_id);
drop policy if exists "profile_verticals write own" on public.profile_verticals;
create policy "profile_verticals write own"
  on public.profile_verticals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── vertical pack seed data ───────────────────────────────────────────────
-- Minimal seed to unblock the onboarding UI. ats_slugs is curated from the
-- already-discovered target_companies in migrations 013/014.
insert into public.vertical_packs (slug, name, description, icon, ats_slugs) values
  ('fintech',    'Fintech',           'Banking, payments, trading, crypto, personal finance.',     '💳',
   '[{"ats_type":"greenhouse","slug":"stripe","name":"Stripe"},
     {"ats_type":"greenhouse","slug":"plaid","name":"Plaid"},
     {"ats_type":"greenhouse","slug":"ramp","name":"Ramp"},
     {"ats_type":"greenhouse","slug":"mercury","name":"Mercury"},
     {"ats_type":"greenhouse","slug":"brex","name":"Brex"},
     {"ats_type":"lever","slug":"wise","name":"Wise"},
     {"ats_type":"greenhouse","slug":"chime","name":"Chime"},
     {"ats_type":"lever","slug":"kraken","name":"Kraken"}]'::jsonb),
  ('health',     'Health & Bio',      'Digital health, biotech, healthtech, medtech.',              '🧬',
   '[{"ats_type":"greenhouse","slug":"oscarhealth","name":"Oscar Health"},
     {"ats_type":"greenhouse","slug":"hingehealth","name":"Hinge Health"},
     {"ats_type":"lever","slug":"ro","name":"Ro"},
     {"ats_type":"greenhouse","slug":"devoted","name":"Devoted Health"},
     {"ats_type":"greenhouse","slug":"headway","name":"Headway"}]'::jsonb),
  ('climate',    'Climate & Energy',  'Clean energy, climate tech, sustainability, carbon markets.','🌱',
   '[{"ats_type":"greenhouse","slug":"watershed","name":"Watershed"},
     {"ats_type":"greenhouse","slug":"pachama","name":"Pachama"},
     {"ats_type":"lever","slug":"rivian","name":"Rivian"},
     {"ats_type":"greenhouse","slug":"tesla","name":"Tesla"}]'::jsonb),
  ('consumer',   'Consumer',          'DTC, marketplaces, social, media, creator economy.',         '🛍️',
   '[{"ats_type":"greenhouse","slug":"doordash","name":"DoorDash"},
     {"ats_type":"greenhouse","slug":"instacart","name":"Instacart"},
     {"ats_type":"greenhouse","slug":"airbnb","name":"Airbnb"},
     {"ats_type":"lever","slug":"substack","name":"Substack"}]'::jsonb),
  ('b2b-saas',   'B2B SaaS',          'Dev tools, data infra, productivity, collaboration.',        '🛠️',
   '[{"ats_type":"greenhouse","slug":"notion","name":"Notion"},
     {"ats_type":"greenhouse","slug":"figma","name":"Figma"},
     {"ats_type":"greenhouse","slug":"linear","name":"Linear"},
     {"ats_type":"lever","slug":"vercel","name":"Vercel"},
     {"ats_type":"greenhouse","slug":"retool","name":"Retool"}]'::jsonb),
  ('cyber',      'Cybersecurity',     'SecOps, GRC, AppSec, infrastructure security.',              '🛡️',
   '[{"ats_type":"greenhouse","slug":"crowdstrike","name":"CrowdStrike"},
     {"ats_type":"greenhouse","slug":"wiz","name":"Wiz"},
     {"ats_type":"greenhouse","slug":"snyk","name":"Snyk"},
     {"ats_type":"lever","slug":"cloudflare","name":"Cloudflare"}]'::jsonb)
on conflict (slug) do update
  set name = excluded.name,
      description = excluded.description,
      icon = excluded.icon,
      ats_slugs = excluded.ats_slugs;
