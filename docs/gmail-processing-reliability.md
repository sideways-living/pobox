# Gmail processing and recovery

## Durable state transitions

Identity is `(workspaceId, provider, providerMessageId)`. A thread is not an
identity: each email in the same thread is processed independently. The current
runtime supports one configured Gmail inbox per workspace; changing inboxes
requires preserving that identity boundary.

| State | Durable evidence | Next action |
| --- | --- | --- |
| Not imported | No MailEvent or review audit for the identity | Fetch and parse |
| Needs review | `mail.needs_review`, without a terminal decision | Leave unread; do not reparse on each poll |
| Handled, acknowledgement pending | MailEvent or terminal review decision, plus unacknowledged MailAcknowledgement | Remove Gmail UNREAD label |
| Retry pending | Same record, attempts incremented, nextAttemptAt delayed | Retry on a subsequent poll when due |
| Acknowledged | MailAcknowledgement.acknowledgedAt set | No further work unless observed unread again |

Processing takes a PostgreSQL transaction-level advisory lock derived from the
full message identity. Both poll workers and review actions take the same lock
at Read Committed isolation. The lock is released on commit, rollback, or loss
of the database connection. No lease can remain stuck after a worker crash.
The unique MailEvent key remains a database backstop. All writers must run this
version; an older worker does not participate in the locking protocol.

Matched mail commits the MailEvent, mailbox flag, audit entry and pending Gmail
acknowledgement together. Unmatched mail commits its review audit, once. Review
resolution commits its optional MailEvent/flag, terminal audit, and pending
acknowledgement together. An identical repeated review decision is idempotent;
a competing different decision receives a conflict. Existing legacy review
audit records remain usable; there is no bulk inbox replay or backfill.

Different messages for the same box each create a history event. Waiting remains
a boolean for mail and a separate boolean for parcels, so an already-waiting box
does not increase the outstanding-box count. Collection still clears both flags.

## Poll cycle and failures

1. Retry up to 100 due acknowledgements from the durable queue.
2. List every page matching the configured Gmail query. Deduplicate overlapping
   pages by message ID; reject repeated page tokens rather than looping.
3. Fetch full messages. A failed individual fetch stays unread and is logged;
   other fetches continue. Authorization failure stops the cycle.
4. Process each message in its database transaction. A failed import stays
   unread and does not prevent later messages from being processed.
5. Retry up to 100 due acknowledgements, including newly committed work. Do not
   attempt the same acknowledgement twice within one poll.

Each Gmail request has a 15-second timeout. Transient network failures, HTTP
408/429/5xx and Gmail rate-limit reasons receive at most three attempts with
250ms/500ms delays. HTTP 401 or OAuth `invalid_grant` reports that Gmail must be
reconnected. Other permanent errors are not immediately retried. Standard OAuth
access-token refresh remains handled by the Google client.

A failed acknowledgement stays pending for at least 60 seconds, with attempts
and a redacted error recorded. The scheduler defaults to 30 minutes, so retry
normally occurs next poll. Existing pending work is retried even if the email
has disappeared from the unread query. A permanent missing-message/permission
error remains pending for operator investigation; it is not falsely recorded
as acknowledged. Provider request headers, credentials and email bodies are
not included in error logs from this path.

Gmail label removal is intentionally **at least once**. A crash after Gmail
succeeds but before the database records success safely repeats label removal.
Mail history and review creation remain once per source identity. Two workers
may both remove the same label, but cannot both import the message.

The in-process guard prevents overlapping cycles and duplicate timer creation.
It does not claim to be a global worker lock; database message locks supply that
protection. Production refuses the volatile MemoryStore. MemoryStore is only
for development and tests and cannot survive process restarts.

## Deployment and verification

Back up PostgreSQL first. Apply `000007_mail_acknowledgements`, regenerate Prisma,
build, then restart all polling workers on the new version. Use the existing
CloudPanel deployment script for an already-migrated VPS. Do not run a mixed
old/new worker deployment. The migration only adds the acknowledgement table
and index; it does not mark historical emails read.

```bash
npm run prisma:generate --workspace server
npm run prisma:migrate --workspace server
npm test
npm run build
```

Run database integration tests only against an explicitly provisioned disposable
PostgreSQL database with the current schema:

```bash
POBOX_TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test
```

Tests create UUID-scoped fixtures and clean up their own workspaces. Without
POBOX_TEST_DATABASE_URL, the PostgreSQL suite is skipped. The normal suite tests
provider retry behavior, partial failures, revocation, restart acknowledgement
recovery, repeated polling, and log redaction using simulated Gmail responses.
The PostgreSQL suite uses independent clients and verifies duplicate imports,
review races, rollback when queue creation fails, and durable pending work.

Verified for this change: all 96 tests passed with PostgreSQL 16, including six
database integration tests. The web/backend production build passed. The new
migration SQL was applied successfully to the disposable database.

During this change, a clean install exposed a pre-existing migration conflict:
`000001_init` creates PostOffice.phone and `000002_post_office_phone` adds it
again. Historical migrations were not rewritten. The disposable database was
bootstrapped with Prisma db push, then the new acknowledgement SQL was applied
and tested directly. This is NOT an instruction to use db push on the VPS.
Repair the historical migration chain separately before claiming clean-install
readiness. Live Gmail OAuth and the deployed VPS were not exercised here.

Remaining boundaries: an interrupted historical import may require individual
message reconciliation; this change does not fix old out-of-order notification
timestamps, live-client invalidation, or complete paginated history/review APIs.
