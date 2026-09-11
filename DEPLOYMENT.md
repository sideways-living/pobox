# pobox.watch Production Deployment

This project is deployed as one CloudPanel Node.js site backed by PM2. The Node server serves both `/api/...` and the built React app from `web/dist`.

## Current VPS Shape

- VPS user: `pobox`
- App directory: `/home/pobox/htdocs/pobox.watch`
- PM2 process: `pobox-watch-api`
- App port: `4175`
- Public URL: `https://pobox.watch`
- Storage: PostgreSQL through Prisma

CloudPanel should be configured as a Node.js site, not a static HTML, PHP, or Python site.

## Required CloudPanel Settings

Set the site to:

```text
App port: 4175
Working directory: /home/pobox/htdocs/pobox.watch
Startup command: bash -lc 'set -a; source .env; set +a; npm run start --workspace server'
```

The app can also be kept running by PM2 directly. In either case, only one process should listen on port `4175`.

## Required VPS `.env`

The production `.env` lives at:

```bash
/home/pobox/htdocs/pobox.watch/.env
```

Required values:

```bash
NODE_ENV=production
PORT=4175
APP_BASE_URL=https://pobox.watch
API_BASE_URL=https://pobox.watch
CORS_ORIGIN=https://pobox.watch
DATABASE_URL=postgresql://mailboxapp:YOUR_DB_PASSWORD@localhost:5432/mailbox
SESSION_SECRET=long-random-secret
ENCRYPTION_KEY=long-random-key
WEBAUTHN_RP_ID=pobox.watch
WEBAUTHN_RP_NAME=pobox.watch
WEBAUTHN_ORIGIN=https://pobox.watch
POBOX_WATCH_STORAGE=prisma
POBOX_WATCH_SEED_DEMO=false
```

Recommended when Apple MapKit is enabled:

```bash
VITE_MAPKIT_TOKEN=your-mapkit-js-token
```

This token must allow the deployed website origin and be loaded before the web build; a PM2 restart alone cannot update it. See [maps, directory and release verification](docs/maps-directory-releases.md) for CSP requirements, safe directory refresh behavior, and browser checks. Version 0.13.8 adds no migration; rebuild native apps to receive native update notices.

Recommended when Gmail polling is enabled:

```bash
MAIL_PROVIDER=gmail
MAIL_POLL_ENABLED=true
MAIL_POLL_WORKSPACE_ID=ws_company
MAIL_POLL_INTERVAL_MS=1800000
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_USER_ID=me
GMAIL_SEARCH_QUERY=is:unread
```

## Normal Deploy

From the VPS:

```bash
ssh -p 22022 -o IdentitiesOnly=yes -o PreferredAuthentications=password pobox@104.207.76.27
cd /home/pobox/htdocs/pobox.watch
bash deploy/scripts/deploy-cloudpanel-pm2.sh
```

The script performs the full production path:

1. Checks the app directory and `.env`.
2. Stashes local VPS drift before pulling.
3. Pulls `origin/main` with `--ff-only`.
4. Runs `npm install --include=dev`.
5. Loads `.env`.
6. Checks required environment variables.
7. Runs `npm run prisma:generate --workspace server`.
8. Runs `npm run prisma:migrate --workspace server`.
9. Runs `npm run build`.
10. Starts or restarts `pobox-watch-api` with PM2.
11. Runs `pm2 save`.
12. Verifies health, version, listening port, and public assets.

By default the script stashes tracked and untracked files. If you only want tracked changes stashed:

```bash
STASH_UNTRACKED=false bash deploy/scripts/deploy-cloudpanel-pm2.sh
```

## Manual Deploy

Use this if you need to step through each command:

```bash
cd /home/pobox/htdocs/pobox.watch

git status --short
git stash push --include-untracked -m "vps local changes before deploy"
git fetch origin main
git checkout main
git pull --ff-only origin main

npm install --include=dev

set -a
source .env
set +a

npm run prisma:generate --workspace server
npm run prisma:migrate --workspace server
npm run build

pm2 restart pobox-watch-api --update-env || pm2 start npm --name pobox-watch-api -- run start --workspace server
pm2 save

bash deploy/scripts/verify-cloudpanel-pm2.sh
```

## Verification Commands

Quick checks:

```bash
cd /home/pobox/htdocs/pobox.watch

pm2 status
ss -ltnp | grep ':4175' || echo "nothing listening on 4175"
curl -sS http://127.0.0.1:4175/api/health
curl -sS https://pobox.watch/api/health
curl -sS https://pobox.watch/ | grep assets
```

Full check:

```bash
cd /home/pobox/htdocs/pobox.watch
bash deploy/scripts/verify-cloudpanel-pm2.sh
```

The full check fails when:

- `.env` is missing required production values.
- `NODE_ENV` is not `production`.
- `POBOX_WATCH_STORAGE` is not `prisma`.
- PM2 does not have `pobox-watch-api` online.
- Nothing is listening on port `4175`.
- `/api/health` does not report the package version.
- The public frontend asset differs from the local `127.0.0.1:4175` asset.
- Public API health does not match the expected version.

## Stale Public Assets

If local and public assets do not match, Nginx or CloudPanel is probably serving an old static directory instead of proxying to the PM2 app.

Run:

```bash
cd /home/pobox/htdocs/pobox.watch

echo "Local app:"
curl -sS http://127.0.0.1:4175/ | grep assets

echo "Public app:"
curl -sS https://pobox.watch/ | grep assets
```

The asset filenames should match. If they do not, check the CloudPanel site reverse proxy settings and any Nginx custom config for a stale `root` or `try_files` rule.

## Wrong Version

The expected version is read from `package.json`.

```bash
node -p "require('./package.json').version"
curl -sS http://127.0.0.1:4175/api/health
curl -sS https://pobox.watch/api/health
```

Both health responses must include the same `version`.

## PM2 Not Listening

If verification says PM2 is online but port `4175` is not listening:

```bash
cd /home/pobox/htdocs/pobox.watch
pm2 logs pobox-watch-api --lines 100 --nostream
pm2 describe pobox-watch-api
pm2 delete pobox-watch-api
set -a; source .env; set +a
pm2 start npm --name pobox-watch-api -- run start --workspace server
pm2 save
```

Then rerun:

```bash
bash deploy/scripts/verify-cloudpanel-pm2.sh
```

## Legacy Systemd/Nginx Files

The files under `deploy/systemd` and the static Nginx example are retained as references for a non-CloudPanel deployment. The production VPS path for `pobox.watch` is the CloudPanel/PM2 path above.

## Backups

Use `deploy/backup/backup-db.sh` from cron or a systemd timer. Store backups outside the app directory, retain at least 30 days, and encrypt off-server copies.
