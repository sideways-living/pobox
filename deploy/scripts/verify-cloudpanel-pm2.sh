#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/pobox/htdocs/pobox.watch}"
APP_PORT="${APP_PORT:-4175}"
PM2_NAME="${PM2_NAME:-pobox-watch-api}"
SITE_URL="${SITE_URL:-https://pobox.watch}"
export PM2_NAME

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

warn() {
  echo "WARN: $*" >&2
}

cd "$APP_DIR" || fail "Cannot cd to $APP_DIR"
[[ -f package.json ]] || fail "package.json not found in $APP_DIR"
[[ -f .env ]] || fail ".env not found in $APP_DIR"

set -a
# shellcheck disable=SC1091
source .env
set +a

required_env=(NODE_ENV PORT DATABASE_URL SESSION_SECRET ENCRYPTION_KEY APP_BASE_URL API_BASE_URL CORS_ORIGIN WEBAUTHN_RP_ID WEBAUTHN_ORIGIN)
for name in "${required_env[@]}"; do
  [[ -n "${!name:-}" ]] || fail "Missing required env var: $name"
done

[[ "${NODE_ENV}" == "production" ]] || fail "NODE_ENV must be production"

if [[ "${PORT}" != "$APP_PORT" ]]; then
  fail ".env PORT is ${PORT}, expected ${APP_PORT}"
fi

storage="${POBOX_WATCH_STORAGE:-${MAILBOX_STORAGE:-}}"
[[ "$storage" == "prisma" ]] || fail "POBOX_WATCH_STORAGE or MAILBOX_STORAGE must be prisma in production"

if [[ -z "${VITE_MAPKIT_TOKEN:-}" ]]; then
  warn "VITE_MAPKIT_TOKEN is not set. Embedded Apple MapKit will use the fallback state."
fi

expected_version="$(node -p "require('./package.json').version")"
[[ -n "$expected_version" ]] || fail "Could not read package version"

pm2 describe "$PM2_NAME" >/dev/null || fail "PM2 process $PM2_NAME is not registered"
pm2_status="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const name=process.env.PM2_NAME;const app=JSON.parse(s).find(item=>item.name===name);process.stdout.write(app?.pm2_env?.status ?? "missing");})')"
[[ "$pm2_status" == "online" ]] || fail "PM2 process $PM2_NAME is $pm2_status"

if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep -q ":${APP_PORT} " || fail "No process is listening on port ${APP_PORT}"
else
  warn "ss is not installed; skipping listening-port check"
fi

health="$(curl -fsS "http://127.0.0.1:${APP_PORT}/api/health")" || fail "Local health check failed"
health_version="$(printf '%s' "$health" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const body=JSON.parse(s); if (!body.ok) process.exit(2); process.stdout.write(body.version || "");})')" || fail "Health response is not valid JSON"
[[ "$health_version" == "$expected_version" ]] || fail "Local API version is ${health_version:-missing}, expected $expected_version"

local_html="$(curl -fsS "http://127.0.0.1:${APP_PORT}/")" || fail "Local app HTML failed"
public_html="$(curl -fsS "$SITE_URL/")" || fail "Public app HTML failed"

local_asset="$(printf '%s' "$local_html" | sed -n 's/.*src="\([^"]*index-[^"]*\.js\)".*/\1/p' | head -1)"
public_asset="$(printf '%s' "$public_html" | sed -n 's/.*src="\([^"]*index-[^"]*\.js\)".*/\1/p' | head -1)"

[[ -n "$local_asset" ]] || fail "Local HTML did not include a built JS asset"
[[ -n "$public_asset" ]] || fail "Public HTML did not include a built JS asset"
[[ "$local_asset" == "$public_asset" ]] || fail "Public asset $public_asset does not match local asset $local_asset. Nginx/CloudPanel may be serving stale static files."

curl -fsS "http://127.0.0.1:${APP_PORT}${local_asset}" >/dev/null || fail "Local JS asset is not served"
curl -fsS "$SITE_URL${public_asset}" >/dev/null || fail "Public JS asset is not served"

public_health="$(curl -fsS "$SITE_URL/api/health")" || fail "Public health check failed"
public_version="$(printf '%s' "$public_health" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const body=JSON.parse(s); if (!body.ok) process.exit(2); process.stdout.write(body.version || "");})')" || fail "Public health response is not valid JSON"
[[ "$public_version" == "$expected_version" ]] || fail "Public API version is ${public_version:-missing}, expected $expected_version"

echo "OK: ${PM2_NAME} is online, port ${APP_PORT} is listening, API version is ${expected_version}, and public assets match the local build."
