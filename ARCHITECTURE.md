# Architecture

Mailbox separates four concepts:

- User identity belongs to an individual person.
- Mailbox state belongs to the shared workspace.
- Location stays private on each user's device.
- Node.js and PostgreSQL are authoritative for shared operational state.

## Runtime

Production runs on Ubuntu LTS with Nginx terminating HTTPS and proxying `/api` and WebSocket traffic to a Fastify Node.js service on localhost. PostgreSQL is reachable only from the server/private network. A systemd service runs the Node process as `mailboxapp`.

The backend depends on an `AppStore` interface. Memory mode keeps the demo/test loop fast; Prisma mode uses PostgreSQL for sessions, workspaces, mailboxes, mail events, collections, invitations, passkeys, devices, and audit events.

## Workspace Model

Users join workspaces through `workspace_members`. A mailbox belongs to one workspace and one post office. A user may later belong to multiple workspaces without duplicating mailbox state.

## Mail Pipeline

Provider integrations implement a small mail provider boundary. Business logic receives normalized provider messages, uses deterministic parsing, creates a `mail_events` row only once per provider message, and sets the matched mailbox to `mailWaiting = true`.

Duplicate protection is message-level, not day-level. If new mail arrives after collection, the mailbox returns to waiting.

## Realtime

The API emits workspace-scoped dashboard updates over WebSockets after controlled mutations. WebSocket subscription authorization uses the same session and workspace membership checks as REST endpoints.

## Location Privacy

iPhone geofencing is on-device. The backend stores post office coordinates and collection actions, not live user movement.

## Conflict Resolution

Collection is explicit and idempotent. If a mailbox has already been collected, later collection attempts receive a conflict instead of creating contradictory state.
