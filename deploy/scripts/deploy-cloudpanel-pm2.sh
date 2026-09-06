#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/pobox/htdocs/pobox.watch}"
APP_PORT="${APP_PORT:-4175}"
PM2_NAME="${PM2_NAME:-pobox-watch-api}"
SITE_URL="${SITE_URL:-https://pobox.watch}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
STASH_UNTRACKED="${STASH_UNTRACKED:-true}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cd "$APP_DIR" || fail "Cannot cd to $APP_DIR"
[[ -f package.json ]] || fail "package.json not found in $APP_DIR"
[[ -f .env ]] || fail ".env not found in $APP_DIR"

echo "Deploying pobox.watch from $APP_DIR using $REMOTE/$BRANCH"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Local VPS drift detected:"
  git status --short
  stash_name="vps deploy drift $(date -u +%Y-%m-%dT%H-%M-%SZ)"
  if [[ "$STASH_UNTRACKED" == "true" ]]; then
    git stash push --include-untracked -m "$stash_name"
  else
    git stash push -m "$stash_name"
  fi
fi

git fetch "$REMOTE" "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only "$REMOTE" "$BRANCH"

npm install --include=dev

set -a
# shellcheck disable=SC1091
source .env
set +a

required_env=(NODE_ENV PORT DATABASE_URL SESSION_SECRET ENCRYPTION_KEY APP_BASE_URL API_BASE_URL CORS_ORIGIN WEBAUTHN_RP_ID WEBAUTHN_ORIGIN)
for name in "${required_env[@]}"; do
  [[ -n "${!name:-}" ]] || fail "Missing required env var: $name"
done
[[ "${NODE_ENV}" == "production" ]] || fail "NODE_ENV must be production"
[[ "${PORT}" == "$APP_PORT" ]] || fail ".env PORT is ${PORT}, expected ${APP_PORT}"

storage="${POBOX_WATCH_STORAGE:-${MAILBOX_STORAGE:-}}"
[[ "$storage" == "prisma" ]] || fail "POBOX_WATCH_STORAGE or MAILBOX_STORAGE must be prisma in production"

npm run prisma:generate --workspace server
npm run prisma:migrate --workspace server
npm run build

if pm2 describe "$PM2_NAME" >/dev/null; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start npm --name "$PM2_NAME" -- run start --workspace server
fi
pm2 save

APP_DIR="$APP_DIR" APP_PORT="$APP_PORT" PM2_NAME="$PM2_NAME" SITE_URL="$SITE_URL" deploy/scripts/verify-cloudpanel-pm2.sh
