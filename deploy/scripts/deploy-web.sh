#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run build --workspace web
sudo rsync -a --delete web/dist/ /var/www/mailbox/web/
sudo nginx -t
sudo systemctl reload nginx
