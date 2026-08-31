# pobox.watch VPS Deployment

## Initial Server

Use Ubuntu LTS. Create a non-root sudo account, configure SSH keys, update packages, and enable UFW:

```bash
sudo apt update && sudo apt upgrade -y
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Disable password SSH only after confirming key access.

## Packages

Install Node.js LTS, Nginx, PostgreSQL, Certbot, build tools, and git.

## Application User

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin poboxwatchapp
sudo mkdir -p /opt/pobox.watch /var/www/pobox.watch/web /etc/pobox.watch
sudo chown -R poboxwatchapp:poboxwatchapp /opt/pobox.watch
```

## PostgreSQL

Keep PostgreSQL on localhost/private interfaces. Create a restricted app user, not a superuser:

```sql
CREATE DATABASE pobox_watch;
CREATE USER poboxwatchapp WITH ENCRYPTED PASSWORD 'replace-me';
GRANT ALL PRIVILEGES ON DATABASE pobox_watch TO poboxwatchapp;
```

Set `DATABASE_URL` in `/etc/pobox.watch/pobox-watch.env` with:

```text
POBOX_WATCH_STORAGE=prisma
POBOX_WATCH_SEED_DEMO=false
```

Then run Prisma migrations with `deploy/scripts/migrate-db.sh`. Do not seed demo users in production unless intentionally standing up a disposable test environment.

## Node Server

Build with `deploy/scripts/deploy-server.sh`. Install `deploy/systemd/pobox-watch-api.service` to `/etc/systemd/system/pobox-watch-api.service`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pobox-watch-api
```

## Web

For a plain Nginx/systemd deployment, build and copy static assets with `deploy/scripts/deploy-web.sh`. For CloudPanel Node.js sites, the Node server can serve `web/dist` directly after `npm run build`; set the app port to `4175` and startup command to `bash -lc 'set -a; source .env; set +a; npm run start --workspace server'`.

## Nginx And TLS

Point DNS for `pobox.watch` at the VPS. Install `deploy/nginx/pobox-watch.conf`, adjust the domain if needed, then request a certificate:

```bash
sudo certbot --nginx -d pobox.watch
sudo certbot renew --dry-run
```

## Backups

Use `deploy/backup/backup-db.sh` from cron or a systemd timer. Store backups outside the app directory, retain at least 30 days, and encrypt off-server copies.
