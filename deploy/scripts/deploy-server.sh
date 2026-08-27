#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run build --workspace server
npm run prisma:migrate --workspace server
sudo systemctl restart mailbox-api
sudo systemctl status mailbox-api --no-pager
