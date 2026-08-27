# Mailbox

Mailbox is a multi-user shared mailbox monitoring system. A central Node.js backend monitors incoming mail notifications, updates one authoritative workspace mailbox state, and syncs iPhone, macOS, and web clients.

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

The development MVP runs with `MAILBOX_STORAGE=memory` by default and includes simulation controls in the web app. PostgreSQL production schema is in `server/prisma/schema.prisma`.

## Current MVP Slice

- Fastify TypeScript API with secure HTTP-only session cookie login.
- Shared workspace state for post offices and mailboxes.
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
