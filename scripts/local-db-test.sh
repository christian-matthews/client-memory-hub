#!/usr/bin/env bash
# Clean-database integration run.
#
# Boots a throwaway local PostgreSQL, stubs the Supabase auth surface
# (roles + auth.uid()/auth.jwt()), applies every migration in order and then runs
# scripts/db-integration.sql with real RLS enforcement (the test role is a plain
# member of `authenticated`, so no bypassrls).
#
#   bash scripts/local-db-test.sh
set -euo pipefail

PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then
  PGBIN="$(dirname "$(command -v initdb)")"
fi
DATA=/tmp/cm-pgdata
PORT=${PORT:-55432}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
unset PGPASSWORD PGSSLMODE || true

rm -rf "$DATA"; mkdir -p "$DATA"
"$PGBIN/initdb" -U postgres -D "$DATA" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=127.0.0.1" -l /tmp/cm-pg.log start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do "$PGBIN/pg_isready" -q && break; sleep 1; done

echo "== supabase stub =================================================="
psql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE tester LOGIN;
GRANT anon, authenticated, service_role, postgres TO tester;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(auth.jwt()->>'sub','')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT auth.jwt()->>'role' $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
SQL

echo "== migraciones sobre base limpia =================================="
for f in supabase/migrations/*.sql; do
  echo "-- $f"
  psql -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "== suite de integracion (RLS real) ================================"
PGUSER=tester psql -v ON_ERROR_STOP=1 -f scripts/db-integration.sql
