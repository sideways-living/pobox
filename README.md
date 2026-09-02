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

The development MVP runs with `POBOX_WATCH_STORAGE=memory` by default and includes simulation controls in the web app.

## PostgreSQL Mode

For durable local development:

```bash
createdb pobox_watch
cp .env.example .env
# set DATABASE_URL and POBOX_WATCH_STORAGE=prisma in .env
npm run prisma:migrate --workspace server
npm run prisma:seed --workspace server
POBOX_WATCH_STORAGE=prisma npm run dev:server
```

The checked-in initial migration lives at `server/prisma/migrations/000001_init/migration.sql`. Demo seeding is explicit in production; `PrismaStore.seedDemo()` does not create demo accounts when `NODE_ENV=production` unless `POBOX_WATCH_SEED_DEMO=true`.

## Current MVP Slice

- Fastify TypeScript API with secure HTTP-only session cookie login.
- Store boundary with memory mode for fast local tests and Prisma/PostgreSQL mode for durable runtime persistence.
- In production, the Node server serves the built React app from `web/dist` as well as `/api`, so a CloudPanel Node.js site can run on one app port.
- Shared workspace state for post offices and PO boxes.
- Deterministic parser for PO Box wording variants.
- Provider message dedupe by `workspace + provider + providerMessageId`.
- Optional Gmail polling every 30 minutes, marking processed or duplicate notification emails as read.
- Explicit collection mutation with authenticated actor attribution.
- WebSocket dashboard updates.
- Responsive React/Vite web app.
- Swift shared models/API client plus iPhone/macOS UI entry-point scaffolds.
- Starlight VPS deployment examples for Nginx, systemd, PostgreSQL backup, and CI.

APNs, provider OAuth setup screens, SMTP delivery, and full Prisma-backed repository wiring are represented in schema/config/docs and are not falsely marked complete.

## Gmail Mail Polling

The backend can poll a Gmail inbox for unread notification emails, parse messages such as `mail is present in box 1234`, update the matching box, and mark processed messages as read. Duplicate provider message IDs are marked read without adding another history event. New emails for a box that is already waiting still add a history event, but the outstanding count stays at one for that box.

Set these in `.env` on the VPS:

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

`MAIL_POLL_INTERVAL_MS=1800000` is 30 minutes. The mail provider boundary is intentionally small so an IMAP provider can replace Gmail later without changing the parser or app state flow.

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
