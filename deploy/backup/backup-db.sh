#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
backup_dir="${BACKUP_DIR:-/var/backups/mailbox}"
mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
pg_dump "$DATABASE_URL" | gzip > "$backup_dir/mailbox-$timestamp.sql.gz"
find "$backup_dir" -name 'mailbox-*.sql.gz' -mtime +30 -delete
