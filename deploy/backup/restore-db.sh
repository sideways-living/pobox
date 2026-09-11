#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${DATABASE_URL:?DATABASE_URL required}"
: "${1:?Usage: restore-db.sh /path/to/backup.dump}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
database="$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))')"
[[ "${RESTORE_CONFIRM:-}" == "$database" ]] || { echo 'Set RESTORE_CONFIRM to the exact empty destination database name.' >&2; exit 1; }
node "$script_dir/checksum.mjs" verify "$1"
tables="$(node "$script_dir/db-tool.mjs" psql -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f');")"
[[ "$tables" == 0 ]] || { echo 'Restore requires an empty destination. Existing data was not changed.' >&2; exit 1; }
node "$script_dir/db-tool.mjs" pg_restore --exit-on-error --single-transaction --no-owner --no-acl "$1"
echo 'Restore completed. Keep polling disabled until application and reconciliation checks pass.'
