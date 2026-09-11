# Production readiness audit - 12 September 2026

Scope: current checkout, web, backend, Prisma schema, shared Apple API client,
macOS and iPhone screens, tests and deployment scripts. This is not a live VPS,
Gmail account, or signed-device validation. No production data was changed.

## Five highest-impact findings

1. **P1 - Different source emails can be silently treated as already handled. Fixed.**
   `server/src/store/prismaStore.ts: processIncomingMail/reviewMatchesProviderMessage`
   and the equivalent MemoryStore code previously accepted a matching Gmail
   thread ID as message identity. Ignoring one message could therefore cause a
   later unmatched notification in that thread to be marked read without its
   own review item. Review checks also ran only after parsing failed, allowing
   ignored messages to be processed after a matching box was added.
   Both stores now scope identity to workspace/provider/message ID and consult
   existing review decisions before parsing. Thread IDs remain descriptive
   metadata. Pending review requires explicit resolution even after adding a box.
   Regression coverage: `mailPoller.test.ts`, `prismaMailIdentity.test.ts`.

2. **P1 - An unread review backlog can starve the inbox poller. Fixed.**
   `server/src/mail/gmailProvider.ts: listUnreadMessages` previously fetched one
   list page only, defaulting to 50 messages. Since review messages stay unread,
   repeated polling could keep seeing the same page and never reach other mail.
   Listing now follows every page, deduplicates overlapping message IDs, and
   rejects repeated page tokens. Listing completes before any UNREAD changes.
   The configured maximum is now explicitly a validated page size, not an
   inbox-wide cap. Regression coverage: `gmailProvider.test.ts`.
   This does not recover emails already marked read by the old thread bug;
   that requires a deliberate source-message reconciliation on the live inbox.

3. **P1 - Logout does not revoke server access. Open.**
   `server/src/api/server.ts: POST /api/v1/auth/logout` clears cookies only.
   `PrismaStore.getSession` still accepts the stored session until expiry;
   `createSession` grants 14 days. `server/src/realtime/hub.ts` tracks only
   workspace/socket, so open connections cannot be revoked by session/user.
   Fix server-side revocation and socket reauthorization/disconnection together.
   Verify a retained cookie fails after logout and membership removal stops an
   already-connected socket. Native logout uses this same endpoint.

4. **P1 - Review resolution is not one atomic, exclusive state transition. Open.**
   `PrismaStore.resolveReviewItem` checks for a duplicate before its transaction,
   writes the mail event/box status inside it, then writes the resolution audit
   afterward. A crash between writes leaves a processed email in the queue;
   competing reviewers can conflict or record inconsistent resolutions.
   `markReviewItemResolved` and `dismissReviewItem` do not claim pending state.
   The Prisma schema has no unique source-message record for pending review;
   the poller's running flag protects only one process. Introduce durable,
   unique message/review state and transactional claims, then test concurrent
   polling, resolution versus ignore, and crash recovery against PostgreSQL.
   Also remove the queue's pre-filter `take: 100` limit: many recent resolved
   items can hide older pending items (`listReviewItems`).

5. **P1 - Open clients can show stale or another actor's dashboard context. Open.**
   `server/src/mail/runtime.ts` and `poller.ts` update the store without emitting
   a workspace change. `web/src/main.tsx: App` has no periodic reconciliation or
   websocket reconnect; it only replaces snapshots on `dashboard.updated`.
   API mutations broadcast the initiating user's entire dashboard, including
   `currentUser`, to every subscriber. A member can consequently see the
   initiating admin's UI context (backend role checks still apply).
   Apple view models load after actions/manual refresh and do not subscribe to
   realtime changes. Broadcast invalidations and refetch per authenticated
   client, with reconnect/foreground reconciliation and poll-completion events.

## Core workflow and coverage

- Gmail OAuth and polling are configured through environment variables; there
  is no working IMAP provider. `EmailConnection`/`ParsingRule` schema records
  are not a complete runtime integration management workflow.
- `mailParser.ts` deterministically matches an unambiguous active box number,
  and parcel collection locations when exactly one active box matches. Its
  tests cover the named Mail2Day/parcel cases, but generic box references are
  also autoaccepted without sender verification. Real HTML email fixtures and
  trusted notification-source rules remain important follow-up work.
- A matched message writes a unique MailEvent, boolean mail/parcel waiting
  state and audit entry in one Prisma transaction. New messages for an already
  waiting box add history without increasing the number of outstanding boxes.
  Late/out-of-order mail currently overwrites latest timestamps and can flag a
  box again after collection; define event-time handling before backlog replay.
- Unmatched mail is stored as audit metadata for review. Resolved/ignored
  messages are acknowledged on their next unread poll. A message-read or fetch
  failure currently aborts the remaining batch; retries occur on the next poll.
- Prisma collection conditionally clears both flags and writes collection and
  audit events transactionally. The existing memory tests cover duplicate
  collection; actual database concurrency still needs integration coverage.
- Web and both native clients expose grouped boxes, collection, management,
  review matching/creation/ignore, and history through the shared API. Native
  browser return is present; real passkey/device interaction was not exercised.
- History is bounded to recent records (50 mail + 50 collection events in the
  Prisma dashboard), without a complete paginated history endpoint.
- Release notes persist dismissal state and have existing tests. Native API
  models and screens need separate verification before claiming full parity.
- Deployment scripts use fail-fast shell options, Prisma generation/migrations,
  build, PM2 and version/asset checks. Backup creation exists, but restore and
  migration rollback were not demonstrated. `/api/health` does not probe the
  database or last successful inbox poll.

## Verification and release boundary

The backend suite passed all 73 tests, including the cross-layer pagination
test. The web/backend production build and both TypeScript checks passed;
Prisma schema validation passed. Native Swift/Xcode validation stalled: Xcode was waiting on filesystem
coordination, and a tracked-source archive attempt also stalled. These checks
were stopped; no successful native build or runtime verification is claimed.

Gmail tests
stub the Google API. Prisma regression tests stub its client; they verify store
decision logic and queries, not PostgreSQL constraints or concurrency. Existing
state tests use MemoryStore. No schema migration is needed for the two fixes.

Before deployment: use an isolated PostgreSQL database for integration tests,
then deploy through `deploy/scripts/deploy-cloudpanel-pm2.sh` and verify the
actual running commit/assets. Gmail OAuth credentials and an authorised test
inbox are needed for a real poll/read-acknowledgement check. MapKit/LCTR setup,
Apple signing and physical-device passkeys remain external verification steps.
Do not blindly mark an old Gmail thread read or replay the full inbox to recover
previous omissions: reconcile individual message IDs and collection timestamps.
