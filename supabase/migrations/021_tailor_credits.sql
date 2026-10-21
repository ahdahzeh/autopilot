-- Migration 021: tailor credits + per-call usage logging.
--
-- Context (2026-10-20): about 30 Per Scholas NY graduates are joining and
-- everyone tailors on the owner's shared Anthropic key. The daily cap drops
-- from 40 to 20 (TAILOR_DAILY_LIMIT in src/lib/billing.ts) and anyone who
-- wants more buys a pack of credits through Stripe Checkout. Three pieces:
--
-- - tailor_events: one row per tailor block (match, cover, ...) with the model
--   id and the token counts the AI SDK reports. Before this the only usage
--   signal was the daily counter in tailor_usage, so the cost of a tailor was
--   a guess. request_id groups the blocks of one request.
--
-- - tailor_credits + tailor_credit_purchases: a balance per user plus a ledger
--   keyed by Stripe checkout session id. The unique key is what makes the
--   webhook idempotent: Stripe retries deliveries, and the billing page also
--   tries to grant when the user lands back on it, so one session can arrive
--   several times and must credit once.
--
-- - record_tailor_use / consume_tailor_credit / add_tailor_credits /
--   refund_tailor_credit: every balance change is a single statement inside a
--   SECURITY DEFINER function, so it is atomic under concurrent requests and
--   users can only read (never write) the credit tables directly. The same
--   now goes for tailor_usage: its insert/update policies from 006 are
--   dropped below, because a counter a user can reset from the browser is no
--   boundary once credits start where it ends.
--
-- Cost per request, for the admin:
--   select request_id, max(model) as model,
--          sum(input_tokens) as input, sum(output_tokens) as output
--     from public.tailor_events group by request_id;
-- Price it with the per-model rates in src/lib/billing.ts.

-- ── tailor_events ──────────────────────────────────────────────────────────

create table if not exists public.tailor_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  -- Plain uuid, no FK: a tailor can run against a job the user deletes a
  -- second later, and a failed insert here must never fail the tailor.
  job_id uuid,
  block text not null,
  model text not null,
  -- Model calls made for this block: 1, plus one for an unparseable first
  -- answer, plus one for the output-guard correction retry.
  calls integer not null default 1,
  -- Uncached prompt tokens only. Cache reads and writes bill at different
  -- rates and have their own columns, so summing input_tokens at the list
  -- price never double counts a cached token (tokenUsageOf in
  -- src/lib/billing.ts does the split).
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  -- How this request was allowed through: the free daily allowance, a
  -- purchased credit, or the user's own Anthropic key (never capped).
  paid_with text not null check (paid_with in ('cap', 'credit', 'own_key')),
  -- False when the block ended in an error after spending tokens.
  ok boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists tailor_events_user_time_idx
  on public.tailor_events (user_id, created_at desc);
create index if not exists tailor_events_request_idx
  on public.tailor_events (request_id);
create index if not exists tailor_events_time_idx
  on public.tailor_events (created_at desc);

alter table public.tailor_events enable row level security;

-- Users read their own rows. Writes come from the route with the service
-- role, so the log cannot be padded from a browser session.
drop policy if exists "tailor_events self read" on public.tailor_events;
create policy "tailor_events self read"
  on public.tailor_events for select
  using (auth.uid() = user_id);

-- ── tailor_credits ─────────────────────────────────────────────────────────

create table if not exists public.tailor_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  purchased_total integer not null default 0,
  used_total integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.tailor_credits enable row level security;

-- Select only. There is deliberately no insert/update policy: the functions
-- below are the only write path.
drop policy if exists "tailor_credits self read" on public.tailor_credits;
create policy "tailor_credits self read"
  on public.tailor_credits for select
  using (auth.uid() = user_id);

-- ── tailor_credit_purchases ────────────────────────────────────────────────

create table if not exists public.tailor_credit_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text,
  pack text not null,
  credits integer not null check (credits > 0),
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'usd',
  created_at timestamptz not null default now()
);

create index if not exists tailor_credit_purchases_user_time_idx
  on public.tailor_credit_purchases (user_id, created_at desc);

alter table public.tailor_credit_purchases enable row level security;

drop policy if exists "tailor_credit_purchases self read" on public.tailor_credit_purchases;
create policy "tailor_credit_purchases self read"
  on public.tailor_credit_purchases for select
  using (auth.uid() = user_id);

-- ── tailor_usage write path ────────────────────────────────────────────────

-- Migration 006 let users insert and update their own tailor_usage row because
-- the route bumped the counter with the user's own session. The counter is a
-- paid boundary now, so a plain `update tailor_usage set count = 0` from a
-- browser session must not work. record_tailor_use() below becomes the only
-- write path; the read policy stays for the settings and billing pages. (The
-- route's pre-021 fallback still tries the old upsert when the RPC is missing,
-- which only happens before this migration runs, while these policies exist.)
drop policy if exists "tailor_usage self upsert" on public.tailor_usage;
drop policy if exists "tailor_usage self update" on public.tailor_usage;

-- ── functions ──────────────────────────────────────────────────────────────

-- Count one tailor against today's free allowance (UTC day, same as the
-- route and the settings page). Returns the new count, or null when the user
-- already reached p_limit today. One statement, so two requests racing at
-- the limit cannot both get through: the second blocks on the row lock and
-- re-evaluates the WHERE against the updated row.
create or replace function public.record_tailor_use(p_limit integer)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.tailor_usage as u (user_id, day, count, updated_at)
  values (auth.uid(), (now() at time zone 'utc')::date, 1, now())
  on conflict (user_id, day) do update
    set count = u.count + 1,
        updated_at = now()
    where u.count < p_limit
  returning u.count;
$$;

-- Spend one purchased credit for the signed-in user. Returns the remaining
-- balance, or null when there was nothing to spend. Same single-statement
-- shape as above: two parallel calls with balance 1 succeed exactly once.
create or replace function public.consume_tailor_credit()
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.tailor_credits
     set balance = balance - 1,
         used_total = used_total + 1,
         updated_at = now()
   where user_id = auth.uid()
     and balance > 0
  returning balance;
$$;

-- Grant purchased credits exactly once per Stripe checkout session. Called
-- with the service role by the webhook and by the billing page, never by
-- users. Returns true when credits were added, false when this session was
-- already recorded (Stripe retried, or the billing page raced the webhook).
create or replace function public.add_tailor_credits(
  p_user_id uuid,
  p_session_id text,
  p_payment_intent_id text,
  p_pack text,
  p_credits integer,
  p_amount_cents integer,
  p_currency text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'add_tailor_credits: credits must be positive';
  end if;

  insert into public.tailor_credit_purchases
    (user_id, stripe_checkout_session_id, stripe_payment_intent_id, pack, credits, amount_cents, currency)
  values
    (p_user_id, p_session_id, p_payment_intent_id, p_pack, p_credits, coalesce(p_amount_cents, 0), coalesce(p_currency, 'usd'))
  on conflict (stripe_checkout_session_id) do nothing;

  -- FOUND is only true when the row was actually inserted. A concurrent
  -- duplicate waits on the unique index until this one commits, then lands
  -- in the conflict branch and returns false.
  if not found then
    return false;
  end if;

  insert into public.tailor_credits as c (user_id, balance, purchased_total, updated_at)
  values (p_user_id, p_credits, p_credits, now())
  on conflict (user_id) do update
    set balance = c.balance + excluded.balance,
        purchased_total = c.purchased_total + excluded.purchased_total,
        updated_at = now();

  return true;
end;
$$;

-- Give a credit back when a paid tailor produced nothing (every block failed
-- before the model answered). Service role only. Returns the new balance.
create or replace function public.refund_tailor_credit(p_user_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.tailor_credits
     set balance = balance + 1,
         used_total = greatest(used_total - 1, 0),
         updated_at = now()
   where user_id = p_user_id
  returning balance;
$$;

-- Supabase grants EXECUTE on new public functions to everyone by default and
-- exposes them as RPC, so narrow each one to the role that should call it.
revoke all on function public.record_tailor_use(integer) from public, anon;
grant execute on function public.record_tailor_use(integer) to authenticated, service_role;

revoke all on function public.consume_tailor_credit() from public, anon;
grant execute on function public.consume_tailor_credit() to authenticated, service_role;

revoke all on function public.add_tailor_credits(uuid, text, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.add_tailor_credits(uuid, text, text, text, integer, integer, text) to service_role;

revoke all on function public.refund_tailor_credit(uuid) from public, anon, authenticated;
grant execute on function public.refund_tailor_credit(uuid) to service_role;
