# Starlight VPS Deployment

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
sudo useradd --system --create-home --shell /usr/sbin/nologin mailboxapp
sudo mkdir -p /opt/mailbox /var/www/mailbox/web /etc/mailbox
sudo chown -R mailboxapp:mailboxapp /opt/mailbox
```

## PostgreSQL

Keep PostgreSQL on localhost/private interfaces. Create a restricted app user, not a superuser:

```sql
CREATE DATABASE mailbox;
CREATE USER mailboxapp WITH ENCRYPTED PASSWORD 'replace-me';
GRANT ALL PRIVILEGES ON DATABASE mailbox TO mailboxapp;
```

Set `DATABASE_URL` in `/etc/mailbox/mailbox.env`, then run Prisma migrations with `deploy/scripts/migrate-db.sh`.

## Node Server

Build with `deploy/scripts/deploy-server.sh`. Install `deploy/systemd/mailbox-api.service` to `/etc/systemd/system/mailbox-api.service`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mailbox-api
```

## Web

Build and copy static assets with `deploy/scripts/deploy-web.sh`.

## Nginx And TLS

Point DNS for `mailbox.example.com` at the VPS. Install `deploy/nginx/mailbox.conf`, replace the domain, then request a certificate:

```bash
sudo certbot --nginx -d mailbox.example.com
sudo certbot renew --dry-run
```

## Backups

Use `deploy/backup/backup-db.sh` from cron or a systemd timer. Store backups outside the app directory, retain at least 30 days, and encrypt off-server copies.
