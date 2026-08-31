#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
backup_dir="${BACKUP_DIR:-/var/backups/pobox.watch}"
mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
pg_dump "$DATABASE_URL" | gzip > "$backup_dir/pobox-watch-$timestamp.sql.gz"
find "$backup_dir" -name 'pobox-watch-*.sql.gz' -mtime +30 -delete
