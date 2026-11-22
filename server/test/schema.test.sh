#!/usr/bin/env bash
# Runs supabase/schema.sql against a throwaway local Postgres and checks the
# credit rules. Needs PostgreSQL installed (initdb, pg_ctl, psql).
#   bash test/schema.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="$(dirname "$(ls /usr/lib/postgresql/*/bin/initdb 2>/dev/null | tail -1 || command -v initdb)")"
dir="$(mktemp -d)"; port=54329
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$dir"
trap 'run "$bin/pg_ctl -D $dir/db stop -m immediate" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
run "$bin/initdb -D $dir/db -A trust -U postgres" >/dev/null
run "$bin/pg_ctl -D $dir/db -o '-p $port -k $dir -c listen_addresses=' -w start" >/dev/null
q() { psql -h "$dir" -p "$port" -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

# The bits of Supabase the schema expects to exist.
q -c "create schema auth; create table auth.users (id uuid primary key); create role anon; create role authenticated; create role service_role;"
q -f "$here/../supabase/schema.sql"
q -f "$here/../supabase/schema.sql"   # running it twice must be harmless

U=11111111-1111-1111-1111-111111111111
q -c "insert into auth.users values ('$U')"
fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok  $1"; else echo "  FAIL $1: expected '$3', got '$2'"; fail=1; fi; }

check "new account gets the free credits"            "$(q -c "select ensure_account('$U','a@b.co',2)")" 2
check "signing in again grants nothing more"         "$(q -c "select ensure_account('$U','a@b.co',2)")" 2
check "spending returns the new balance"             "$(q -c "select spend_credit('$U','stage:1')")" 1
check "spending the last credit"                     "$(q -c "select spend_credit('$U','stage:2')")" 0
check "spending with none left is refused (-1)"      "$(q -c "select spend_credit('$U','stage:3')")" -1
check "balance never goes negative"                  "$(q -c "select credits from accounts where user_id='$U'")" 0
check "refund adds one back"                         "$(q -c "select add_credits('$U',1,'refund','refund:2')")" 1
check "same refund twice only counts once"           "$(q -c "select add_credits('$U',1,'refund','refund:2')")" 1
check "purchase adds the pack"                       "$(q -c "select add_credits('$U',25,'purchase','stripe:cs_1')")" 26
check "repeated payment notification is ignored"     "$(q -c "select add_credits('$U',25,'purchase','stripe:cs_1')")" 26
check "ledger adds up to the balance"                "$(q -c "select sum(delta) from credit_ledger where user_id='$U'")" 26
check "ledger rows: signup, 2 stages, refund, purchase" "$(q -c "select count(*) from credit_ledger")" 5
# Ten simultaneous spends against 3 credits: exactly 3 may succeed.
q -c "update accounts set credits=3 where user_id='$U'"
for i in $(seq 1 10); do q -c "select spend_credit('$U','race:$i')" > "$dir/r$i" & done; wait
check "10 simultaneous spends on 3 credits: 3 succeed" "$(cat "$dir"/r* | grep -vc -- '-1')" 3
check "…and the balance ends at 0"                   "$(q -c "select credits from accounts where user_id='$U'")" 0
# Auto top-up claims.
q -c "update accounts set credits=10 where user_id='$U'"
check "auto top-up is off by default"                "$(q -c "select claim_auto_topup('$U',3,600) is null")" t
q -c "select set_auto_topup('$U','pack50','cus_1')"
check "on, but balance above threshold: no claim"    "$(q -c "select claim_auto_topup('$U',3,600) is null")" t
q -c "update accounts set credits=3 where user_id='$U'"
for i in $(seq 1 10); do q -c "select claim_auto_topup('$U',3,600) is not null" > "$dir/c$i" & done; wait
check "10 simultaneous claims: exactly 1 wins"       "$(cat "$dir"/c* | grep -c t)" 1
q -c "update accounts set auto_last_at=null where user_id='$U'"
check "…and it names the pack and customer"          "$(q -c "select c->>'pack' || '/' || (c->>'customer') from claim_auto_topup('$U',3,600) c")" "pack50/cus_1"
check "inside the cool-down: no claim"               "$(q -c "select claim_auto_topup('$U',3,600) is null")" t
q -c "select set_auto_topup('$U',null,null)"
check "turning it off keeps the customer on file"    "$(q -c "select (get_account('$U')->>'auto_pack') is null and get_account('$U')->>'stripe_customer' = 'cus_1'")" t
check "purchases start without an amount"             "$(q -c "select (list_purchases('$U')->0->>'amount_cents') is null and json_array_length(list_purchases('$U')) = 1")" t
q -c "select note_payment('stripe:cs_1', 1900)"
check "purchase history shows credits and amount"    "$(q -c "select (p->>'credits') || '/' || (p->>'amount_cents') || '/' || (p->>'ref') from json_array_elements(list_purchases('$U')) p")" "25/1900/stripe:cs_1"
V=22222222-2222-2222-2222-222222222222
q -c "insert into auth.users values ('$V')"; q -c "select ensure_account('$V','v@b.co',0)" >/dev/null
check "first Stripe customer is stored"              "$(q -c "select set_stripe_customer('$V','cus_a')")" cus_a
check "a second one does not replace it"             "$(q -c "select set_stripe_customer('$V','cus_b')")" cus_a
# Background stagings.
W=33333333-3333-3333-3333-333333333333; J1=aaaaaaaa-0000-0000-0000-000000000001; J2=aaaaaaaa-0000-0000-0000-000000000002; J3=aaaaaaaa-0000-0000-0000-000000000003
q -c "insert into auth.users values ('$W')"; q -c "select ensure_account('$W','w@b.co',2)" >/dev/null
check "create_staging takes a credit"                "$(q -c "select create_staging('$W','$J1','a.jpg','bedroom','coastal','',1200,800,true)")" 1
check "…and records the job as queued"               "$(q -c "select status from stagings where id='$J1'")" queued
check "second staging takes the last credit"         "$(q -c "select create_staging('$W','$J2','b.jpg','auto','modern','',1200,800,false)")" 0
check "no credit, no job"                            "$(q -c "select create_staging('$W','$J3','c.jpg','auto','modern','',1200,800,false)")||$(q -c "select count(*) from stagings where id='$J3'")" "-1||0"
check "start_staging hands the worker the job"       "$(q -c "select start_staging('$J1')->>'style'")" coastal
check "finishing ok marks it done"                   "$(q -c "select finish_staging('$J1', true, null)")/$(q -c "select status from stagings where id='$J1'")" "t/done"
check "finishing twice does nothing"                 "$(q -c "select finish_staging('$J1', false, 'x')")/$(q -c "select status from stagings where id='$J1'")" "f/done"
check "a failure refunds the credit"                 "$(q -c "select finish_staging('$J2', false, 'boom')")/$(q -c "select credits from accounts where user_id='$W'")" "t/1"
check "…only once"                                   "$(q -c "select finish_staging('$J2', false, 'boom')")/$(q -c "select credits from accounts where user_id='$W'")" "f/1"
check "list shows both, newest first"                "$(q -c "select string_agg(x->>'status', ',') from json_array_elements(list_stagings('$W', 30)) x")" "error,done"
check "status is only visible to its owner"          "$(q -c "select coalesce(staging_status('$W','$J1'),'-')")/$(q -c "select coalesce(staging_status('$U','$J1'),'-')")" "done/-"
check "a running job cannot be deleted"              "$(q -c "select create_staging('$W','$J3','c.jpg','auto','modern','',1200,800,false)") $(q -c "select delete_staging('$W','$J3')")" "0 f"
q -c "update stagings set created_at = now() - interval '30 minutes' where id='$J3'"
check "a stuck job is failed and refunded"           "$(q -c "select json_array_length(fail_stale_stagings(20))")/$(q -c "select status from stagings where id='$J3'")/$(q -c "select credits from accounts where user_id='$W'")" "1/error/1"
check "a finished job can be deleted"                "$(q -c "select delete_staging('$W','$J3')")" t
q -c "update stagings set created_at = now() - interval '31 days' where id='$J2'"
check "purge removes stagings older than 30 days"    "$(q -c "select json_array_length(purge_stagings(30))")/$(q -c "select count(*) from stagings where user_id='$W'")" "1/1"
check "browser roles cannot reach stagings"          "$(q -c "select has_function_privilege('anon','create_staging(uuid,uuid,text,text,text,text,integer,integer,boolean)','execute') or has_function_privilege('authenticated','list_stagings(uuid,integer)','execute') or has_function_privilege('anon','finish_staging(uuid,boolean,text)','execute')")" f
# Promo codes.
P=44444444-4444-4444-4444-444444444444; Q=55555555-5555-5555-5555-555555555555
q -c "insert into auth.users values ('$P'),('$Q')"; q -c "select ensure_account('$P','p@b.co',0), ensure_account('$Q','q@b.co',0)" >/dev/null
q -c "insert into promo_codes (code, credits, max_uses) values (' beta 25 ', 25, 1)"
check "codes are stored in capitals, spaces removed" "$(q -c "select code from promo_codes")" BETA25
check "redeeming adds the credits"                   "$(q -c "select redeem_promo('$P','beta25')->>'credits'")" 25
check "the same account can't use it twice"          "$(q -c "select redeem_promo('$P','BETA25')->>'error'")" already
check "a code past its use limit is refused"         "$(q -c "select redeem_promo('$Q','BETA25')->>'error'")" used_up
q -c "insert into promo_codes (code, credits, expires_at) values ('OLD', 5, now() - interval '1 day')"
check "an expired code is refused"                   "$(q -c "select redeem_promo('$Q','OLD')->>'error'")" expired
check "an unknown code is refused"                   "$(q -c "select redeem_promo('$Q','NOPE')->>'error'")" invalid
for i in $(seq 1 10); do q -c "select redeem_promo('$Q','WRONG$i')" >/dev/null; done
q -c "insert into promo_codes (code, credits) values ('REAL', 5)"
check "10 wrong guesses in an hour locks guessing"   "$(q -c "select redeem_promo('$Q','REAL')->>'error'")" too_many
check "promo shows in purchase history"              "$(q -c "select x->>'reason' || '/' || (x->>'credits') from json_array_elements(list_purchases('$P')) x")" promo/25
check "ledger matches the balance"                   "$(q -c "select sum(delta) from credit_ledger where user_id='$P'")" 25
check "rate_hit allows up to the limit"              "$(q -c "select string_agg(rate_hit('k','ip1',3,60)::text, ',') from generate_series(1,4)")" "true,true,true,false"
check "…counted separately per key"                 "$(q -c "select rate_hit('k','ip2',3,60)")" t
q -c "select record_staging_usage('$J1', 1300, 5400, 0.1715)"
check "usage and cost are recorded on a staging"    "$(q -c "select output_tokens || '/' || cost_usd from stagings where id='$J1'")" "5400/0.1715"
q -c "select note_event('human','a@b.co'), note_event('hit:code-ip','1.2.3.4')"
check "recent_event finds a fresh event"             "$(q -c "select recent_event('human','a@b.co',60)")/$(q -c "select recent_event('human','z@b.co',60)")" "t/f"
check "period_stats summarises the day"              "$(q -c "select (period_stats(24)->'limit_hits'->>'hit:code-ip') || '/' || (period_stats(24)->>'stagings_done')")" "1/1"
check "usage_today counts today's stagings"          "$(q -c "select (usage_today()->>'stagings')::int >= 0")" t
# Follow-up emails.
N1=66666666-0000-0000-0000-000000000001; N2=66666666-0000-0000-0000-000000000002; N3=66666666-0000-0000-0000-000000000003; N4=66666666-0000-0000-0000-000000000004
q -c "insert into auth.users values ('$N1'),('$N2'),('$N3'),('$N4')"
q -c "select ensure_account('$N1','new@b.co',10), ensure_account('$N2','user@b.co',10), ensure_account('$N3','buyer@b.co',0), ensure_account('$N4','off@b.co',10)" >/dev/null
q -c "update accounts set created_at = now() - interval '2 days' where user_id in ('$N1','$N4')"
q -c "update accounts set created_at = now() - interval '9 days', credits = 0 where user_id='$N2'"
q -c "insert into credit_ledger (user_id, delta, reason, ref, created_at) values ('$N2', -1, 'stage', 'n2s', now() - interval '3 days')"
q -c "insert into credit_ledger (user_id, delta, reason, ref, created_at) values ('$N3', 25, 'purchase', 'n3p', now() - interval '60 days'), ('$N3', -1, 'stage', 'n3s', now() - interval '35 days')"
q -c "select set_emails_off('$N4')"
check "nudges: new, out-of-credits and lapsed buyer" "$(q -c "select string_agg(x->>'email' || ':' || (x->>'kind'), ',' order by x->>'email') from json_array_elements(nudge_candidates(100)) x where x->>'email' like '%@b.co'")" "buyer@b.co:return-30,new@b.co:stage-1,user@b.co:buy-2"
check "an unsubscribed account gets nothing"         "$(q -c "select count(*) from json_array_elements(nudge_candidates(100)) x where x->>'email' = 'off@b.co'")" 0
check "mark_nudge records once"                      "$(q -c "select mark_nudge('$N1','stage-1')")/$(q -c "select mark_nudge('$N1','stage-1')")" "t/f"
check "…and the same email isn't offered again"      "$(q -c "select count(*) from json_array_elements(nudge_candidates(100)) x where x->>'email' = 'new@b.co'")" 0
check "browser roles cannot call spend_credit"       "$(q -c "select has_function_privilege('authenticated','spend_credit(uuid,text)','execute') or has_function_privilege('anon','add_credits(uuid,integer,text,text)','execute') or has_function_privilege('anon','claim_auto_topup(uuid,integer,integer)','execute') or has_function_privilege('authenticated','set_auto_topup(uuid,text,text)','execute') or has_function_privilege('anon','get_account(uuid)','execute') or has_function_privilege('authenticated','list_purchases(uuid)','execute') or has_function_privilege('anon','note_payment(text,integer)','execute') or has_function_privilege('authenticated','set_stripe_customer(uuid,text)','execute') or has_function_privilege('authenticated','redeem_promo(uuid,text)','execute') or has_function_privilege('anon','rate_hit(text,text,integer,integer)','execute') or has_function_privilege('authenticated','period_stats(integer)','execute') or has_function_privilege('anon','note_event(text,text)','execute') or has_function_privilege('anon','nudge_candidates(integer)','execute') or has_function_privilege('authenticated','set_emails_off(uuid)','execute')")" f
check "server role can"                              "$(q -c "select has_function_privilege('service_role','add_credits(uuid,integer,text,text)','execute')")" t
check "row level security is on"                     "$(q -c "select bool_and(relrowsecurity) from pg_class where relname in ('accounts','credit_ledger','stagings','promo_codes','promo_redemptions','promo_attempts','rate_events','nudges_sent')")" t
[ $fail = 0 ] && echo "SCHEMA OK" || { echo "SCHEMA FAILED"; exit 1; }
