# pobox.watch

pobox.watch is a multi-user shared PO box monitoring system. A central Node.js backend monitors incoming mail notifications, updates one authoritative workspace PO box state, and syncs iPhone, macOS, and web clients.

## Local Development

```bash
npm install
npm run dev:server
npm run dev:web
```

Demo accounts use `Password123!`:

- `daniel@example.com` Admin
- `sarah@example.com` Member
- `john@example.com` Member

The development MVP runs with `MAILBOX_STORAGE=memory` by default and includes simulation controls in the web app.

## PostgreSQL Mode

For durable local development:

```bash
createdb mailbox
cp .env.example .env
# set DATABASE_URL and MAILBOX_STORAGE=prisma in .env
npm run prisma:migrate --workspace server
npm run prisma:seed --workspace server
MAILBOX_STORAGE=prisma npm run dev:server
```

The checked-in initial migration lives at `server/prisma/migrations/000001_init/migration.sql`. Demo seeding is explicit in production; `PrismaStore.seedDemo()` does not create demo accounts when `NODE_ENV=production` unless `MAILBOX_SEED_DEMO=true`.

## Current MVP Slice

- Fastify TypeScript API with secure HTTP-only session cookie login.
- Store boundary with memory mode for fast local tests and Prisma/PostgreSQL mode for durable runtime persistence.
- In production, the Node server serves the built React app from `web/dist` as well as `/api`, so a CloudPanel Node.js site can run on one app port.
- Shared workspace state for post offices and PO boxes.
- Deterministic parser for PO Box wording variants.
- Provider message dedupe by `workspace + provider + providerMessageId`.
- Explicit collection mutation with authenticated actor attribution.
- WebSocket dashboard updates.
- Responsive React/Vite web app.
- Swift shared models/API client plus iPhone/macOS UI entry-point scaffolds.
- Starlight VPS deployment examples for Nginx, systemd, PostgreSQL backup, and CI.

Passkeys, APNs, provider OAuth, SMTP delivery, and full Prisma-backed repository wiring are represented in schema/config/docs and are not falsely marked complete.

## Test

```bash
npm test
npm run build
```

## CloudPanel Runtime

After `npm run build`, start one Node.js app:

```bash
set -a
source .env
set +a
npm run start --workspace server
```

Use app port `4175`. In production, `/api/...` routes go to Fastify and all other browser routes fall back to `web/dist/index.html`.
