# Needs Review

The queue includes sender, subject, received time (or explicitly labelled import
time when unavailable), readable email content, notification type, parsed guess,
and reason. HTML bodies are converted to text; email markup is never executed.
The original audit record remains unchanged. Completed records are filtered by
workspace, provider and message ID; older unresolved items are not silently capped.
The current API returns all unresolved items; very large queues may need server
pagination in a future release.

Members can read the queue. Administrators can:

- Match an existing box and mark the corresponding mail/parcel flag waiting.
- Select a post office and create a missing box while resolving in one request.
- Ignore an email after confirmation, without changing a box.
- Resolve without a box change after a separate explicit confirmation.

`POST /api/v1/workspaces/:workspaceId/review-items/:id/resolve` accepts exactly
one of `{ "mailboxId": "..." }` or
`{ "newMailbox": { "postOfficeId": "...", "boxNumber": "3020" } }`.
Existing native clients can continue using mailboxId. Creating new post offices
remains on the Post Offices page.

Prisma resolution holds the source-message transaction lock shared with polling.
Optional box creation, flag/event writes, actor-attributed audit history and
source-email acknowledgement queueing commit together. Creation locks the post
office row before duplicate-number checks. A failed acknowledgement queue write
rolls everything back, including the new box. An identical retry returns the
previous result without another event or box; a conflicting decision returns 409.
No historical audit records are deleted. Gmail is not called inside the transaction:
the poller later removes UNREAD and retries failures using the durable queue.

The web disables actions while saving, shows request failures inline with retry
and refresh options, and reloads the review queue when dashboard updates arrive.

## Verification

- `npm test`: API details, permissions, malformed requests, matching and creation.
- With a disposable `POBOX_TEST_DATABASE_URL`: PostgreSQL atomic rollback,
  competing administrators, idempotent creation, provider isolation and old items.
- `npm run build`: server and web TypeScript plus production assets.
- Browser fixture: build first, then run
  `npm exec --workspace server -- tsx tests/support/reviewBrowserServer.ts`.
  This binds only 127.0.0.1:4189, uses synthetic in-memory data, and prints a test
  session. It refuses a production environment. Provide that session as
  `REVIEW_SESSION` to `node scripts/verify-review-browser.mjs` with Playwright
  available (`PLAYWRIGHT_MODULE` can point to its installed index.mjs).
  The browser script uses installed Chrome and checks desktop/mobile rendering,
  details, create-and-resolve, matching, request failure/retry, ignore cancellation
  and confirmation, and the empty state. Authentication is a fixture, not a
  passkey test. All review operations use the real local API. Stop the fixture
  after testing; never deploy it as the application entry point.

No schema migration is added here. The durable acknowledgement migration from
the preceding Gmail reliability change must already be installed on deployment.
