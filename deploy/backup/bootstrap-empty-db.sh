#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
database="$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))')"
[[ "${BOOTSTRAP_CONFIRM:-}" == "$database" ]] || { echo 'Set BOOTSTRAP_CONFIRM to the exact NEW empty database name.' >&2; exit 1; }
tables="$(node deploy/backup/db-tool.mjs psql -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f');")"
[[ "$tables" == 0 ]] || { echo 'Bootstrap requires an empty database. No changes made.' >&2; exit 1; }
# Initial SQL already contains PostOffice.phone. Preserve historical checksums.
node deploy/backup/db-tool.mjs psql -X -v ON_ERROR_STOP=1 --single-transaction -f server/prisma/migrations/000001_init/migration.sql
npm exec --workspace server -- prisma migrate resolve --applied 000001_init
npm exec --workspace server -- prisma migrate resolve --applied 000002_post_office_phone
npm run prisma:migrate --workspace server
