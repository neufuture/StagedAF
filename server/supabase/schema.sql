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
