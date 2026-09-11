#!/usr/bin/env bash
set -euo pipefail
umask 077
main() {
APP_DIR="${APP_DIR:-/home/pobox/htdocs/pobox.watch}"
RELEASES_DIR="${RELEASES_DIR:-/home/pobox/releases/pobox.watch}"
PM2_NAME="${PM2_NAME:-pobox-watch-api}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
cd "$APP_DIR"
export ENV_FILE="$APP_DIR/.env"
[[ -f "$ENV_FILE" ]] || { echo 'Missing .env' >&2; exit 1; }
for tool in git node npm pm2 tar pg_dump pg_restore; do command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }; done
[[ -z "$(git ls-files -- .env)" ]] || { echo 'Refusing to deploy a tracked .env' >&2; exit 1; }
mkdir -p "$RELEASES_DIR"
lock="$RELEASES_DIR/.deploy-lock"
mkdir "$lock" || { echo 'Deployment lock exists. Check for another deploy before removing it.' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
trap 'echo "Deployment stopped. Inspect the failed step; no automatic database rollback was attempted." >&2' ERR
if [[ -n "$(git status --porcelain)" ]]; then
  git stash push --include-untracked -m "pobox deployment drift $(date -u +%Y%m%dT%H%M%SZ)"
  git rev-parse refs/stash > "$RELEASES_DIR/last-drift-stash"
  echo "Drift preserved in stash $(cat "$RELEASES_DIR/last-drift-stash"). Do not pop it into a release."
fi
git fetch "$REMOTE" "$BRANCH"
target="$(git rev-parse FETCH_HEAD)"
if [[ -n "${DEPLOY_COMMIT:-}" && "$DEPLOY_COMMIT" != "$target" ]]; then
  echo 'Fetched branch tip differs from DEPLOY_COMMIT; stopping before install/migration.' >&2; exit 1
fi
git checkout "$BRANCH"
git merge --ff-only "$target"
[[ "$(git rev-parse HEAD)" == "$target" ]] || { echo 'Local branch is ahead of the intended remote commit; preserved, not reset.' >&2; exit 1; }
export DEPLOY_COMMIT="$target"
export RELEASE_DIR="$RELEASES_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${target:0:12}-$$"
mkdir "$RELEASE_DIR"
git archive "$target" | tar -x -C "$RELEASE_DIR"
cd "$RELEASE_DIR"
set -a
source "$ENV_FILE"
set +a
export WEB_DIST_PATH="$RELEASE_DIR/web/dist"
node deploy/scripts/validate-env.mjs
export APP_PORT="${APP_PORT:-$PORT}"
export SITE_URL="${SITE_URL:-$APP_BASE_URL}"
[[ "$APP_PORT" == "$PORT" ]] || { echo 'APP_PORT and PORT differ' >&2; exit 1; }
npm ci --include=dev
npm run prisma:generate --workspace server
npm run build
node deploy/scripts/stamp-release.mjs "$DEPLOY_COMMIT"
export BACKUP_DIR="${BACKUP_DIR:-$RELEASES_DIR/backups}"
bash deploy/backup/backup-db.sh
npm run prisma:migrate --workspace server
export PM2_NAME
node deploy/scripts/write-pm2-config.mjs
pm2 startOrRestart "$RELEASE_DIR/ecosystem.deploy.json" --only "$PM2_NAME" --update-env
verified=false
for attempt in {1..12}; do
  if bash deploy/scripts/verify-cloudpanel-pm2.sh; then verified=true; break; fi
  sleep 5
done
[[ "$verified" == true ]] || { echo 'Readiness failed; PM2 state was not saved. Inspect logs and migration compatibility before rollback.' >&2; exit 1; }
pm2 save
printf '%s\n' "$RELEASE_DIR" > "$RELEASES_DIR/last-successful-release"
echo "Deployment verified: $DEPLOY_COMMIT at $RELEASE_DIR"
}
main "$@"
