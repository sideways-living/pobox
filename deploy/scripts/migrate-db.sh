#!/usr/bin/env bash
set -euo pipefail

npm run prisma:migrate --workspace server
