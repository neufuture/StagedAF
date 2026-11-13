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
check "browser roles cannot call spend_credit"       "$(q -c "select has_function_privilege('authenticated','spend_credit(uuid,text)','execute') or has_function_privilege('anon','add_credits(uuid,integer,text,text)','execute')")" f
check "server role can"                              "$(q -c "select has_function_privilege('service_role','add_credits(uuid,integer,text,text)','execute')")" t
check "row level security is on"                     "$(q -c "select bool_and(relrowsecurity) from pg_class where relname in ('accounts','credit_ledger')")" t
[ $fail = 0 ] && echo "SCHEMA OK" || { echo "SCHEMA FAILED"; exit 1; }
