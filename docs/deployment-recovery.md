# Deployment and recovery runbook

## What a backup contains

`deploy/backup/backup-db.sh` creates a PostgreSQL custom-format archive, validates its archive directory and writes a SHA-256 sidecar. Partial failures are not published as completed archives. Permissions default to owner-only and passwords are passed to PostgreSQL tools in the environment, not process arguments. Large checksums are streamed.

Schedule this independently of deployments (for example daily) using a protected wrapper that loads the trusted `.env`. Keep at least 30 days, copy encrypted archives plus checksums off-server, monitor failures and test restores periodically. The deploy script also backs up before migrations. No automated off-site upload, retention deletion, encryption service or scheduler is configured by this change.

An archive is a consistent database snapshot, not a complete server backup. Separately protect the exact source commit/release, `.env` secrets (especially `ENCRYPTION_KEY`), OAuth configuration, PostgreSQL roles/permissions/extensions, CloudPanel/Nginx/TLS settings and PM2/systemd setup. A checksum detects accidental corruption, not a maliciously replaced archive and checksum. Restore only trusted archives. A successful `pg_restore --list` does not replace a restore test.

## Restore procedure

1. Stop the app and all polling workers, including other PM2/systemd instances. Record the incident time, current release, database identity and latest source-message IDs. Take an additional incident backup when possible.
2. Provision a NEW empty PostgreSQL database owned by the intended application role. Do not drop the old database. Use a compatible PostgreSQL restore client/server; test the actual production major versions.
3. In a protected shell, set `DATABASE_URL` to the new destination. Do not overwrite the production `.env` yet. Set `RESTORE_CONFIRM` to the destination database name.

```bash
RESTORE_CONFIRM=mailbox_restored bash deploy/backup/restore-db.sh /secure/backups/pobox-watch-TIMESTAMP.dump
```

The command verifies the checksum, refuses existing user tables/views/sequences, and restores with `--exit-on-error --single-transaction --no-owner --no-acl`. Failure rolls back the restore transaction. Legacy `.sql.gz` backups require a separately reviewed restore into an empty database with `psql -X -v ON_ERROR_STOP=1 --single-transaction`; this new helper intentionally accepts checked custom archives only.

4. Validate row counts, users/memberships, post offices/boxes, waiting flags, collection/audit history, encrypted authenticator readability and source-message acknowledgement records. Compare with recorded evidence, not only an HTTP 200.
5. Select the matching application release. Check `prisma migrate status`; only apply newer migrations after explicitly deciding to roll forward. Set `MAIL_POLL_ENABLED=false` while testing the restored app.
6. Reconcile mail received/collected since the snapshot. A database restore cannot undo Gmail messages already marked read, sent invitations, or user actions after the snapshot. Replaying notifications blindly can reflag already-collected mail; never mark an entire thread unread/read as a recovery shortcut. Loss of newer sessions/passkeys/recovery-code usage can also require session revocation and user security review.
7. After verification, switch the protected `.env` to the restored database, regenerate the selected release's PM2 config from that environment, start it, verify locally/publicly and save PM2. Resume polling only after reconciliation. Retain the old database for investigation.

## Application rollback limits

Releases are immutable build directories; `last-successful-release` identifies the last verified one, but it is not automatically selected after a failure. A failed migration may have partially applied nontransactional historical SQL. A failed readiness check after restart leaves the attempted process available for diagnosis, not silently reverted.

Rollback application code only after confirming the migrated schema and newly written data remain compatible with the earlier code. Prisma `migrate deploy` does not reverse migrations. Do not delete migration history or mark failed migrations applied without inspecting their actual effects. Prefer a forward fix when possible. The first move from the legacy in-place deployment has no prior immutable release directory; retain the legacy checkout/build/PM2 details before that transition.

For a reviewed compatible previous release, load the protected `.env`, set `RELEASE_DIR` to that existing release and `WEB_DIST_PATH` to its `web/dist`, set `PM2_NAME=pobox-watch-api`, run its `write-pm2-config.mjs`, then `pm2 startOrRestart "$RELEASE_DIR/ecosystem.deploy.json" --only "$PM2_NAME" --update-env`. Verify that release's manifest/commit before `pm2 save`. Never reuse an old saved environment after a database or credential change without reviewing it.

## New empty installation

Historical migration `000001_init` already contains `PostOffice.phone`; `000002_post_office_phone` adds it again. Applied migrations were not rewritten. For a genuinely new empty database only:

```bash
BOOTSTRAP_CONFIRM=mailbox_new bash deploy/backup/bootstrap-empty-db.sh
```

With `DATABASE_URL` pointing at that database, this loads the initial SQL transactionally, records the initial and redundant phone migrations as applied, then runs remaining migrations. It refuses populated databases. If interrupted after initial creation, inspect migration state rather than rerunning or resetting production. Normal upgrades and restored backups do not use bootstrap.

## Repeatable local evidence

```bash
node --test deploy/tests/deployment.test.mjs
RECOVERY_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:PORT/source_test \
RESTORE_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:PORT/restore_test \
node deploy/tests/recovery-drill.mjs
```

Use two disposable loopback databases ending `_test`; bootstrap the source and leave the restore database empty. The drill uses actual local Git, npm, Prisma, PM2 in a temporary `PM2_HOME`, builds, backup/restore and HTTP byte verification. Port 4188 must be free. It uses local HTTP for both verification endpoints; it does not test CloudPanel, public DNS/TLS, VPS reboot, live Gmail or Apple authorization. It deletes its temporary files by default and leaves database schemas in the disposable databases. Set `KEEP_RECOVERY_DRILL=true` only when deliberately retaining protected diagnostic artifacts.

Additional validation: `npm test` with `POBOX_TEST_DATABASE_URL` pointing at a disposable migrated database, `npm run typecheck`, `npm run build`, `swift test --package-path apple`, and both Xcode targets. With Playwright and Chrome available, `node scripts/verify-browser-suite.mjs` runs the isolated review, management, multi-user, map-fallback/release and virtual-authenticator security flows. It expects a token-free web build and free loopback ports 4189/4190. This is not physical-device authentication proof.

The September 12 local drill passed on PostgreSQL 18 with matching version-18 client tools. Production PostgreSQL/OS versions, root-installed PM2 startup, off-site backup retention and a real reboot remain external checks. Two existing moderate Vitest test-tooling advisories remain; no unrelated major dependency upgrade was forced.
