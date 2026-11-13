-- UnitStager accounts and credits.
-- Run this once in the Supabase dashboard: SQL Editor → paste → Run.
-- Safe to run again.

create table if not exists public.accounts (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  credits    integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now()
);

-- Every change to a balance, for support questions and bookkeeping.
create table if not exists public.credit_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.accounts (user_id) on delete cascade,
  delta      integer not null,
  reason     text not null,          -- signup | stage | refund | purchase | manual
  ref        text unique,            -- makes each grant / charge apply at most once
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

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

revoke all on function public.ensure_account(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.spend_credit(uuid, text) from public, anon, authenticated;
revoke all on function public.add_credits(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.ensure_account(uuid, text, integer) to service_role;
grant execute on function public.spend_credit(uuid, text) to service_role;
grant execute on function public.add_credits(uuid, integer, text, text) to service_role;
