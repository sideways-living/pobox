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
- CloudPanel/PM2 VPS deployment scripts with verification for env, Prisma, PM2, version, and stale frontend assets.

APNs, provider OAuth setup screens, SMTP delivery, and full Prisma-backed repository wiring are represented in schema/config/docs and are not falsely marked complete.

## Gmail Mail Polling

The backend can poll a Gmail inbox for unread notification emails, parse messages such as `Mail2Day: PO Box 3020 has mail`, update the matching box, and mark handled messages as read. New emails for a box that is already waiting still add a history event, but the outstanding count stays at one for that box.

Polling behavior is intentionally explicit:

- Matched mail notifications create one mail history event, flag `mailWaiting`, and are marked read in Gmail.
- Matched parcel notifications create one parcel history event, flag `parcelWaiting`, and are marked read in Gmail.
- Already imported Gmail message IDs are treated as duplicates and marked read without adding another history event.
- Unclear messages create one Needs Review item and stay unread until a user resolves or ignores the item.
- Repeated unread messages with the same Gmail message ID or same Gmail thread ID do not create more Needs Review rows.
- Reviewed or ignored Needs Review items are treated as handled on the next poll, so Gmail can mark the original source message read.

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

## Apple Maps On The Web

The web app uses Apple MapKit JS for embedded maps. Apple Maps pages cannot be embedded directly in an iframe, so the production build needs a MapKit JS token:

```bash
VITE_MAPKIT_TOKEN=your-apple-mapkit-token
```

Set this in `.env` before running `npm run build`. Without it, pobox.watch still shows Apple Maps links and the fallback route board. Admins see a small setup notice; members only see the operational fallback. Production CSP must allow MapKit JS resources from `https://cdn.apple-mapkit.com` and Apple map service requests under `https://*.apple-mapkit.com`.

## Test

```bash
npm test
npm run build
```

## CloudPanel Runtime

Production deploys should use the hardened CloudPanel/PM2 path in `DEPLOYMENT.md`:

```bash
cd /home/pobox/htdocs/pobox.watch
bash deploy/scripts/deploy-cloudpanel-pm2.sh
```

Use app port `4175`. In production, `/api/...` routes go to Fastify and all other browser routes fall back to `web/dist/index.html`. To verify an already deployed VPS without redeploying, run `bash deploy/scripts/verify-cloudpanel-pm2.sh`.
