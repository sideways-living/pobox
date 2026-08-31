#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run build --workspace server
npm run prisma:migrate --workspace server
sudo systemctl restart pobox-watch-api
sudo systemctl status pobox-watch-api --no-pager
