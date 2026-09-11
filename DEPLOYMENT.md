# pobox.watch: CloudPanel and PM2 deployment

## Production layout

- SSH: `ssh -p 22022 -o IdentitiesOnly=yes -o PreferredAuthentications=password pobox@104.207.76.27`
- Source checkout: `/home/pobox/htdocs/pobox.watch`, branch `main`, remote `origin`.
- Configuration: `/home/pobox/htdocs/pobox.watch/.env`, mode `600`, never tracked by Git.
- Built releases: `/home/pobox/releases/pobox.watch/<timestamp>-<commit>-<pid>`.
- PM2: `pobox-watch-api`, one fork-mode instance, port `4175`.
- CloudPanel: Node.js site proxying `https://pobox.watch` to port `4175`. PM2 runs the app; do not start a second copy in Terminal or a separate service. Nginx must not serve an older checkout's `web/dist`.

## Configuration

Use `.env.example` as the list of supported options. These values are required by the deploy validator:

```dotenv
NODE_ENV=production
PORT=4175
APP_BASE_URL=https://pobox.watch
API_BASE_URL=https://pobox.watch
CORS_ORIGIN=https://pobox.watch
DATABASE_URL=postgresql://mailboxapp:REPLACE_WITH_URL_ENCODED_PASSWORD@localhost:5432/mailbox
SESSION_SECRET=REPLACE_WITH_DISTINCT_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
ENCRYPTION_KEY=REPLACE_WITH_DISTINCT_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
WEBAUTHN_RP_ID=pobox.watch
WEBAUTHN_RP_NAME=pobox.watch
WEBAUTHN_ORIGIN=https://pobox.watch
POBOX_WATCH_STORAGE=prisma
POBOX_WATCH_SEED_DEMO=false
MAIL_POLL_ENABLED=false
```

Replace placeholders; preserve existing real secrets during upgrades. Rotating `ENCRYPTION_KEY` without a migration makes encrypted authenticators unreadable. `.env` is trusted shell configuration and must use shell-safe quoting. Do not paste its values into logs or support chats. PM2's generated config and saved process dump contain environment secrets: protect those files and the release directory too.

For Gmail, enable polling only with `MAIL_PROVIDER=gmail`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `MAIL_POLL_WORKSPACE_ID` and an interval such as `MAIL_POLL_INTERVAL_MS=1800000`. OAuth authorization and inbox access require a separate live test.

`VITE_MAPKIT_TOKEN` is optional. Set a restricted public Apple Maps token before building, not an Apple private key. See [map/directory/release checks](docs/maps-directory-releases.md). An absent token provides location links.

## Repeatable deploy

Prerequisites: Node 22+, npm, Git authentication to the intended repository, PM2, `tar`, and PostgreSQL client tools compatible with the server. `pg_dump` cannot dump a newer major server. Ensure adequate disk for a complete dependency tree, web/server build and database backup per release.

From the trusted, updated checkout on the VPS:

```bash
cd /home/pobox/htdocs/pobox.watch
chmod 600 .env
DEPLOY_COMMIT=FULL_40_CHARACTER_COMMIT_SHA bash deploy/scripts/deploy-cloudpanel-pm2.sh
```

Replace the SHA with the full reviewed commit that has been pushed to `origin/main`. If omitted, the script explicitly selects the fetched branch tip and reports it. A supplied SHA must match that tip; this normal deploy path is not a rollback command. The current local implementation must be pushed before the VPS can fetch it.

The script:

1. Acquires a deployment lock and saves tracked/untracked drift in a Git stash. Ignored `.env` stays untouched. `last-drift-stash` records the stash ID; existing stashes remain intact.
2. Fetches the branch once, checks the intended SHA, fast-forwards without reset and rejects local commits ahead of the selected commit.
3. Exports that exact commit into a new release directory. Local PM2 config drift is preserved, not silently reused.
4. Loads/validates `.env`, sets the release's `WEB_DIST_PATH`, runs `npm ci --include=dev`, generates Prisma and builds. The running release is not overwritten.
5. Stamps the built commit/version and hashes HTML/assets. Creates a checked database archive before migration.
6. Applies existing migrations. Migration errors stop before restart. Build deliberately precedes migration, reducing schema changes caused by a broken build.
7. Starts/restarts the named PM2 process with the selected script/cwd/environment. Retries readiness a bounded number of times.
8. Requires local and public database-backed readiness, exact commit/version/storage, matching built HTML and matching JS/CSS bytes. PM2 `online` alone is insufficient.
9. Only then runs `pm2 save` and writes `last-successful-release`.

Failure stops the script. Failed releases, backups and stashes remain for inspection. Never use `git reset --hard`, `stash pop`, or automatic database rollback to make an error disappear. A stale `.deploy-lock` after a machine crash must only be removed after confirming no deployment is running. No automatic release or backup pruning is performed.

## Verification and reboot

```bash
RELEASES_DIR=/home/pobox/releases/pobox.watch bash deploy/scripts/verify-cloudpanel-pm2.sh
pm2 logs pobox-watch-api --lines 80 --nostream
```

Override `RELEASE_DIR` and `DEPLOY_COMMIT` to verify a selected release independently of the last-successful pointer. Public TLS/DNS failure, HTML-as-JavaScript fallback, same-version wrong commit and stale asset contents all fail verification. `/api/health` is liveness; `/api/ready` queries the application database. Readiness does not prove Gmail OAuth, delivery, MapKit authorization or end-to-end sign-in.

PM2 startup installation is a separate root/admin step: as `pobox`, run `pm2 startup`, then run its generated command using a permitted administrator account. Run `pm2 save` only after verification. Reboot recovery must be tested on the actual VPS in a maintenance window; a local PM2 test is not proof of systemd startup configuration.

## Backup, restore and rollback

Follow [the recovery runbook](docs/deployment-recovery.md). A restore requires an explicitly confirmed empty destination. Do not point the recovery drill at production. Native applications are separate releases and are not updated by a VPS deploy.
