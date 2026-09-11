#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${DATABASE_URL:?DATABASE_URL required}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
backup_dir="${BACKUP_DIR:-/var/backups/pobox.watch}"
mkdir -p "$backup_dir"
file="$backup_dir/pobox-watch-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
trap 'rm -f "$file.partial"' EXIT
node "$script_dir/db-tool.mjs" pg_dump --format=custom --no-owner --no-acl --file "$file.partial"
pg_restore --list "$file.partial" >/dev/null
mv "$file.partial" "$file"
node "$script_dir/checksum.mjs" write "$file"
echo "Backup created and archive checked: $file"
