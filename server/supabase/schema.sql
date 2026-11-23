-- UnitStager accounts and credits.
-- Run this once in the Supabase dashboard: SQL Editor → paste → Run.
-- Safe to run again.

create table if not exists public.accounts (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  credits    integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now()
);

-- Auto top-up: the Stripe customer whose saved card may be charged, which pack
-- to buy (null = off), and when it last fired (so it cannot fire twice at once).
alter table public.accounts add column if not exists stripe_customer text;
alter table public.accounts add column if not exists auto_pack text;
alter table public.accounts add column if not exists auto_last_at timestamptz;

-- Every change to a balance, for support questions and bookkeeping.
create table if not exists public.credit_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.accounts (user_id) on delete cascade,
  delta      integer not null,
  reason     text not null,          -- signup | stage | refund | purchase | auto-topup | manual
  ref        text unique,            -- makes each grant / charge apply at most once
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

-- What was paid for a purchase, for the customer's purchase history.
alter table public.credit_ledger add column if not exists amount_cents integer;

-- Nobody reads or writes these tables directly from a browser: with row level
-- security on and no policies, only the server's secret key can touch them.
alter table public.accounts enable row level security;
alter table public.credit_ledger enable row level security;

-- Create the account on first sign-in, with free credits. Returns the balance.
create or replace function public.ensure_account(p_user uuid, p_email text, p_free integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  insert into accounts (user_id, email, credits) values (p_user, p_email, greatest(p_free, 0))
  on conflict (user_id) do nothing;
  if found and p_free > 0 then
    insert into credit_ledger (user_id, delta, reason, ref) values (p_user, p_free, 'signup', 'signup:' || p_user);
  end if;
  select credits into v from accounts where user_id = p_user;
  return v;
end $$;

-- Take one credit. Returns the new balance, or -1 if the balance was zero.
create or replace function public.spend_credit(p_user uuid, p_ref text)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  update accounts set credits = credits - 1 where user_id = p_user and credits > 0 returning credits into v;
  if not found then return -1; end if;
  insert into credit_ledger (user_id, delta, reason, ref) values (p_user, -1, 'stage', p_ref);
  return v;
end $$;

-- Add credits (purchase, refund, manual grant). The same p_ref is only ever
-- applied once, so a repeated payment notification cannot double-credit.
create or replace function public.add_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  insert into credit_ledger (user_id, delta, reason, ref) values (p_user, p_amount, p_reason, p_ref)
  on conflict (ref) do nothing;
  if found then
    update accounts set credits = credits + p_amount where user_id = p_user returning credits into v;
  else
    select credits into v from accounts where user_id = p_user;
  end if;
  return v;
end $$;

-- Balance and auto top-up state for one account.
create or replace function public.get_account(p_user uuid)
returns json language sql security definer set search_path = public as $$
  select json_build_object('credits', credits, 'auto_pack', auto_pack, 'has_card', stripe_customer is not null, 'stripe_customer', stripe_customer)
  from accounts where user_id = p_user;
$$;

-- Turn auto top-up on (p_pack = a pack id) or off (p_pack = null). A customer
-- id, when given, is remembered; passing null keeps the one already stored.
create or replace function public.set_auto_topup(p_user uuid, p_pack text, p_customer text)
returns void language sql security definer set search_path = public as $$
  update accounts set auto_pack = p_pack, stripe_customer = coalesce(p_customer, stripe_customer) where user_id = p_user;
$$;

-- Decide whether an auto top-up should fire now. Returns the pack and customer
-- to charge, or null. Atomic: of any number of simultaneous calls, at most one
-- gets a non-null answer, and not again until p_min_seconds have passed.
create or replace function public.claim_auto_topup(p_user uuid, p_threshold integer, p_min_seconds integer)
returns json language plpgsql security definer set search_path = public as $$
declare v json;
begin
  update accounts set auto_last_at = now()
  where user_id = p_user and auto_pack is not null and stripe_customer is not null and credits <= p_threshold
    and (auto_last_at is null or auto_last_at < now() - make_interval(secs => p_min_seconds))
  returning json_build_object('pack', auto_pack, 'customer', stripe_customer, 'stamp', (extract(epoch from auto_last_at) * 1000)::bigint) into v;
  return v;
end $$;

-- Record what a purchase cost (kept separate from add_credits so that adding
-- credits never depends on it).
create or replace function public.note_payment(p_ref text, p_cents integer)
returns void language sql security definer set search_path = public as $$
  update credit_ledger set amount_cents = p_cents where ref = p_ref;
$$;

-- An account's purchases, newest first.
create or replace function public.list_purchases(p_user uuid)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
    select created_at, delta as credits, reason, ref, amount_cents
    from credit_ledger where user_id = p_user and reason in ('purchase', 'auto-topup')
    order by created_at desc limit 50
  ) x;
$$;

-- Remember the Stripe customer for an account (first one wins), so receipts,
-- saved cards and the customer portal all refer to the same customer.
create or replace function public.set_stripe_customer(p_user uuid, p_customer text)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  update accounts set stripe_customer = p_customer where user_id = p_user and stripe_customer is null;
  select stripe_customer into v from accounts where user_id = p_user;
  return v;
end $$;

revoke all on function public.set_stripe_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.set_stripe_customer(uuid, text) to service_role;

revoke all on function public.note_payment(text, integer) from public, anon, authenticated;
revoke all on function public.list_purchases(uuid) from public, anon, authenticated;
grant execute on function public.note_payment(text, integer) to service_role;
grant execute on function public.list_purchases(uuid) to service_role;

revoke all on function public.get_account(uuid) from public, anon, authenticated;
revoke all on function public.set_auto_topup(uuid, text, text) from public, anon, authenticated;
revoke all on function public.claim_auto_topup(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.get_account(uuid) to service_role;
grant execute on function public.set_auto_topup(uuid, text, text) to service_role;
grant execute on function public.claim_auto_topup(uuid, integer, integer) to service_role;

revoke all on function public.ensure_account(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.spend_credit(uuid, text) from public, anon, authenticated;
revoke all on function public.add_credits(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.ensure_account(uuid, text, integer) to service_role;
grant execute on function public.spend_credit(uuid, text) to service_role;
grant execute on function public.add_credits(uuid, integer, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Background stagings. Each photo staged through the website or extension is
-- a row here; the staged result is kept in Cloudflare R2 for 30 days.

create table if not exists public.stagings (
  id          uuid primary key,
  user_id     uuid not null references public.accounts (user_id) on delete cascade,
  name        text not null,
  room        text,
  style       text,
  custom      text,
  width       integer,
  height      integer,
  label       boolean not null default false,
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  error       text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index if not exists stagings_user_idx on public.stagings (user_id, created_at desc);
alter table public.stagings enable row level security;

-- Which AppFolio property / unit each credit was spent on (sent by the
-- extension; empty for the website). Kept on the ledger, which is never
-- purged, so usage can later be totalled per property.
alter table public.credit_ledger add column if not exists property_id   text;
alter table public.credit_ledger add column if not exists property_name text;
alter table public.credit_ledger add column if not exists unit_id       text;
alter table public.credit_ledger add column if not exists unit_name     text;
create index if not exists credit_ledger_property_idx on public.credit_ledger (user_id, property_id) where property_id is not null;

drop function if exists public.create_staging(uuid, uuid, text, text, text, text, integer, integer, boolean);
-- Take one credit and record the staging, together. Returns the new balance,
-- or -1 if there were no credits (and nothing is recorded).
create or replace function public.create_staging(p_user uuid, p_id uuid, p_name text, p_room text, p_style text, p_custom text,
                                                 p_width integer, p_height integer, p_label boolean,
                                                 p_property_id text default null, p_property text default null,
                                                 p_unit_id text default null, p_unit text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  update accounts set credits = credits - 1 where user_id = p_user and credits > 0 returning credits into v;
  if not found then return -1; end if;
  insert into credit_ledger (user_id, delta, reason, ref, property_id, property_name, unit_id, unit_name)
    values (p_user, -1, 'stage', 'stage:' || p_id, p_property_id, p_property, p_unit_id, p_unit);
  insert into stagings (id, user_id, name, room, style, custom, width, height, label)
    values (p_id, p_user, p_name, p_room, p_style, p_custom, p_width, p_height, coalesce(p_label, false));
  return v;
end $$;

-- The worker's view of a job, and marking it started.
create or replace function public.start_staging(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v json;
begin
  update stagings set status = 'running', started_at = coalesce(started_at, now())
  where id = p_id and status in ('queued', 'running')
  returning json_build_object('id', id, 'user_id', user_id, 'room', room, 'style', style, 'custom', custom, 'width', width, 'height', height) into v;
  return v;
end $$;

-- Finish a job. On failure the credit is refunded, exactly once. Finishing a
-- job that is already finished does nothing. Returns true if this call finished it.
create or replace function public.finish_staging(p_id uuid, p_ok boolean, p_error text)
returns boolean language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  update stagings set status = case when p_ok then 'done' else 'error' end, error = case when p_ok then null else p_error end, finished_at = now()
  where id = p_id and status in ('queued', 'running')
  returning user_id into u;
  if u is null then return false; end if;
  if not p_ok then
    insert into credit_ledger (user_id, delta, reason, ref, property_id, property_name, unit_id, unit_name)
      select u, 1, 'refund', 'refund:' || p_id, l.property_id, l.property_name, l.unit_id, l.unit_name
      from (select 1) one left join credit_ledger l on l.ref = 'stage:' || p_id
      on conflict (ref) do nothing;
    if found then update accounts set credits = credits + 1 where user_id = u; end if;
  end if;
  return true;
end $$;

-- An account's stagings from the last p_days days, newest first.
create or replace function public.list_stagings(p_user uuid, p_days integer)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
    select id, name, room, style, label, status, error, created_at, finished_at
    from stagings where user_id = p_user and created_at > now() - make_interval(days => p_days)
    order by created_at desc limit 300
  ) x;
$$;

-- Is this staging the account's, and finished? Returns its status, or null.
create or replace function public.staging_status(p_user uuid, p_id uuid)
returns text language sql security definer set search_path = public as $$
  select status from stagings where id = p_id and user_id = p_user;
$$;

-- Delete one finished staging. Returns true if it was deleted.
create or replace function public.delete_staging(p_user uuid, p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from stagings where id = p_id and user_id = p_user and status in ('done', 'error');
  return found;
end $$;

-- Remove stagings older than p_days; returns what was removed so its files can be deleted.
create or replace function public.purge_stagings(p_days integer)
returns json language sql security definer set search_path = public as $$
  with gone as (delete from stagings where created_at < now() - make_interval(days => p_days) returning id, user_id)
  select coalesce(json_agg(row_to_json(gone)), '[]'::json) from gone;
$$;

-- Jobs stuck for more than p_minutes (the worker died): fail them with a refund.
create or replace function public.fail_stale_stagings(p_minutes integer)
returns json language plpgsql security definer set search_path = public as $$
declare r record; out json := '[]'::json; ids uuid[] := '{}';
begin
  for r in select id, user_id from stagings where status in ('queued', 'running') and created_at < now() - make_interval(mins => p_minutes) loop
    perform finish_staging(r.id, false, 'Staging took too long and was stopped. Your credit was returned.');
    ids := ids || r.id;
  end loop;
  select coalesce(json_agg(json_build_object('id', s.id, 'user_id', s.user_id)), '[]'::json) into out from stagings s where s.id = any(ids);
  return out;
end $$;

do $$
declare f text;
begin
  foreach f in array array['create_staging(uuid, uuid, text, text, text, text, integer, integer, boolean, text, text, text, text)', 'start_staging(uuid)',
    'finish_staging(uuid, boolean, text)', 'list_stagings(uuid, integer)', 'staging_status(uuid, uuid)', 'delete_staging(uuid, uuid)',
    'purge_stagings(integer)', 'fail_stale_stagings(integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Promo codes: free credits, e.g. for testers. Create them in Supabase's Table
-- Editor (table promo_codes) or with SQL, for example:
--   insert into promo_codes (code, credits, max_uses, expires_at, note)
--   values ('BETA25', 25, 50, now() + interval '60 days', 'Portland beta testers');
-- Each account can use a given code once.

create table if not exists public.promo_codes (
  code       text primary key check (code ~ '^[A-Z0-9-]{3,40}$'),
  credits    integer not null check (credits > 0 and credits <= 10000),
  max_uses   integer check (max_uses is null or max_uses > 0),   -- empty = unlimited
  uses       integer not null default 0,
  expires_at timestamptz,                                         -- empty = never
  active     boolean not null default true,
  note       text,
  created_at timestamptz not null default now()
);
create table if not exists public.promo_redemptions (
  code       text not null references public.promo_codes (code) on delete cascade,
  user_id    uuid not null references public.accounts (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (code, user_id)
);
create table if not exists public.promo_attempts (
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index if not exists promo_attempts_idx on public.promo_attempts (user_id, at);
alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;
alter table public.promo_attempts enable row level security;

-- Codes are stored in capitals without spaces, however they were typed in.
create or replace function public.promo_code_tidy() returns trigger language plpgsql as $$
begin
  new.code := upper(regexp_replace(new.code, '\s', '', 'g'));
  return new;
end $$;
drop trigger if exists promo_code_tidy on public.promo_codes;
create trigger promo_code_tidy before insert or update of code on public.promo_codes for each row execute function public.promo_code_tidy();

-- Redeem a code. Returns {"ok":true,"added":n,"credits":balance} or
-- {"ok":false,"error":"invalid|expired|used_up|already|too_many"}.
create or replace function public.redeem_promo(p_user uuid, p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare c promo_codes; v integer; clean text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
begin
  if (select count(*) from promo_attempts where user_id = p_user and at > now() - interval '1 hour') >= 10 then
    return json_build_object('ok', false, 'error', 'too_many');
  end if;
  select * into c from promo_codes where code = clean for update;
  if not found or not c.active then
    insert into promo_attempts (user_id) values (p_user);
    return json_build_object('ok', false, 'error', 'invalid');
  end if;
  if c.expires_at is not null and c.expires_at < now() then return json_build_object('ok', false, 'error', 'expired'); end if;
  if exists (select 1 from promo_redemptions where code = clean and user_id = p_user) then return json_build_object('ok', false, 'error', 'already'); end if;
  if c.max_uses is not null and c.uses >= c.max_uses then return json_build_object('ok', false, 'error', 'used_up'); end if;
  insert into promo_redemptions (code, user_id) values (clean, p_user);
  update promo_codes set uses = uses + 1 where code = clean;
  insert into credit_ledger (user_id, delta, reason, ref) values (p_user, c.credits, 'promo', 'promo:' || clean || ':' || p_user);
  update accounts set credits = credits + c.credits where user_id = p_user returning credits into v;
  return json_build_object('ok', true, 'added', c.credits, 'credits', v, 'code', clean);
end $$;

-- Purchase history now also lists promo codes used.
create or replace function public.list_purchases(p_user uuid)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
    select created_at, delta as credits, reason, ref, amount_cents
    from credit_ledger where user_id = p_user and reason in ('purchase', 'auto-topup', 'promo')
    order by created_at desc limit 50
  ) x;
$$;

revoke all on function public.redeem_promo(uuid, text) from public, anon, authenticated;
grant execute on function public.redeem_promo(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Rate limits (sign-in codes, promo guesses, free sign-up credits per network).

create table if not exists public.rate_events (
  kind text not null,
  key  text not null,
  at   timestamptz not null default now()
);
create index if not exists rate_events_idx on public.rate_events (kind, key, at);
alter table public.rate_events enable row level security;

-- Record one event and say whether it is within the limit (true) or over it
-- (false, and nothing is recorded). Old events are trimmed as it goes.
create or replace function public.rate_hit(p_kind text, p_key text, p_limit integer, p_minutes integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_kind || ':' || p_key));
  delete from rate_events where kind = p_kind and key = p_key and at < now() - make_interval(mins => p_minutes);
  select count(*) into n from rate_events where kind = p_kind and key = p_key;
  if n >= p_limit then return false; end if;
  insert into rate_events (kind, key) values (p_kind, p_key);
  return true;
end $$;

-- Housekeeping: drop events older than a month.
create or replace function public.trim_rate_events()
returns void language sql security definer set search_path = public as $$
  delete from rate_events where at < now() - interval '31 days';
$$;

revoke all on function public.rate_hit(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.trim_rate_events() from public, anon, authenticated;
grant execute on function public.rate_hit(text, text, integer, integer) to service_role;
grant execute on function public.trim_rate_events() to service_role;

-- ---------------------------------------------------------------------------
-- Observability: what each staging cost, notable events, and daily totals.

alter table public.stagings add column if not exists input_tokens integer;
alter table public.stagings add column if not exists output_tokens integer;
alter table public.stagings add column if not exists cost_usd numeric(10, 4);

-- Record what OpenAI reported for a finished staging, and its estimated cost.
create or replace function public.record_staging_usage(p_id uuid, p_input integer, p_output integer, p_cost numeric)
returns void language sql security definer set search_path = public as $$
  update stagings set input_tokens = p_input, output_tokens = p_output, cost_usd = p_cost where id = p_id;
$$;

-- Note something worth counting in the daily summary (limit hit, sign-up check passed...).
create or replace function public.note_event(p_kind text, p_key text)
returns void language sql security definer set search_path = public as $$
  insert into rate_events (kind, key) values (p_kind, left(coalesce(p_key, ''), 200));
$$;

-- Has this event happened for this key within p_minutes?
create or replace function public.recent_event(p_kind text, p_key text, p_minutes integer)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from rate_events where kind = p_kind and key = p_key and at > now() - make_interval(mins => p_minutes));
$$;

-- Stagings and estimated image cost since midnight UTC.
create or replace function public.usage_today()
returns json language sql security definer set search_path = public as $$
  select json_build_object('stagings', count(*), 'cost_usd', coalesce(sum(cost_usd), 0))
  from stagings where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
$$;

-- Totals for the last p_hours, for the daily summary email.
create or replace function public.period_stats(p_hours integer)
returns json language sql security definer set search_path = public as $$
  with since as (select now() - make_interval(hours => p_hours) as t)
  select json_build_object(
    'new_accounts',      (select count(*) from accounts, since where created_at > since.t),
    'free_credits',      (select coalesce(sum(delta), 0) from credit_ledger, since where reason = 'signup' and created_at > since.t),
    'promo_credits',     (select coalesce(sum(delta), 0) from credit_ledger, since where reason = 'promo' and created_at > since.t),
    'purchases',         (select count(*) from credit_ledger, since where reason in ('purchase', 'auto-topup') and created_at > since.t),
    'revenue_cents',     (select coalesce(sum(amount_cents), 0) from credit_ledger, since where reason in ('purchase', 'auto-topup') and created_at > since.t),
    'stagings_done',     (select count(*) from stagings, since where status = 'done' and created_at > since.t),
    'stagings_failed',   (select count(*) from stagings, since where status = 'error' and created_at > since.t),
    'cost_usd',          (select coalesce(sum(cost_usd), 0) from stagings, since where created_at > since.t),
    'avg_cost_usd',      (select round(avg(cost_usd), 4) from stagings, since where cost_usd is not null and created_at > since.t),
    'credits_unused',    (select coalesce(sum(credits), 0) from accounts),
    'limit_hits',        (select coalesce(json_object_agg(kind, n), '{}'::json) from (select kind, count(*) n from rate_events, since where kind like 'hit:%' and at > since.t group by kind) h)
  );
$$;

do $$
declare f text;
begin
  foreach f in array array['record_staging_usage(uuid, integer, integer, numeric)', 'note_event(text, text)', 'recent_event(text, text, integer)',
    'usage_today()', 'period_stats(integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Follow-up emails ("nudges"): each kind is sent to an account at most once,
-- never to accounts that unsubscribed.

alter table public.accounts add column if not exists emails_off boolean not null default false;
create table if not exists public.nudges_sent (
  user_id uuid not null references public.accounts (user_id) on delete cascade,
  kind    text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind)
);
alter table public.nudges_sent enable row level security;

-- Who should get which follow-up today. Stagings are read from the credit
-- ledger (kept for good), not the stagings table (emptied after 30 days).
--   stage-1   signed up 20 h – 3 days ago, credits left, never staged
--   stage-4   signed up 4 – 8 days ago, credits left, never staged
--   buy-2     staged, now out of credits for a day or more, never bought, no auto top-up
--   return-30 has bought, last staging 30 – 45 days ago
create or replace function public.nudge_candidates(p_limit integer)
returns json language sql security definer set search_path = public as $$
  with st as (select user_id, max(created_at) as last_stage from credit_ledger where reason = 'stage' group by user_id),
  paid as (select distinct user_id from credit_ledger where reason in ('purchase', 'auto-topup')),
  c as (
    select a.user_id, a.email, a.credits, 'stage-1' as kind from accounts a left join st using (user_id)
      where st.user_id is null and a.credits > 0 and a.created_at < now() - interval '20 hours' and a.created_at > now() - interval '3 days'
    union all
    select a.user_id, a.email, a.credits, 'stage-4' from accounts a left join st using (user_id)
      where st.user_id is null and a.credits > 0 and a.created_at < now() - interval '4 days' and a.created_at > now() - interval '8 days'
    union all
    select a.user_id, a.email, a.credits, 'buy-2' from accounts a join st using (user_id)
      where a.credits = 0 and a.auto_pack is null and a.user_id not in (select user_id from paid)
        and st.last_stage < now() - interval '1 day' and st.last_stage > now() - interval '10 days'
    union all
    select a.user_id, a.email, a.credits, 'return-30' from accounts a join st using (user_id)
      where a.user_id in (select user_id from paid) and st.last_stage < now() - interval '30 days' and st.last_stage > now() - interval '45 days'
  )
  select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
    select c.* from c join accounts a using (user_id)
    where not a.emails_off and not exists (select 1 from nudges_sent n where n.user_id = c.user_id and n.kind = c.kind)
    limit p_limit
  ) x;
$$;

-- Record that a follow-up was sent. False if it had been already (send nothing).
create or replace function public.mark_nudge(p_user uuid, p_kind text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into nudges_sent (user_id, kind) values (p_user, p_kind) on conflict do nothing;
  return found;
end $$;

create or replace function public.set_emails_off(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update accounts set emails_off = true where user_id = p_user;
$$;

do $$
declare f text;
begin
  foreach f in array array['nudge_candidates(integer)', 'mark_nudge(uuid, text)', 'set_emails_off(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Tell the Supabase API to pick up new tables and functions straight away.
notify pgrst, 'reload schema';
