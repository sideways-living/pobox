# Post office and PO box management

Post Offices groups active boxes under their office. Mail and parcel waiting
flags remain independent. Last event chooses the latest mail, parcel or collection
timestamp and labels the event correctly. Collection clears both waiting flags
and records the authenticated collector.

Administrators can add, edit and remove offices and boxes. Members can view and
collect but cannot manage records. The API rejects blank office names/addresses,
blank box numbers and out-of-range coordinates. Multiple boxes at one office are
allowed. Box numbers are normalized consistently with email matching; duplicate
numbers within an office are rejected, including moves that omit boxNumber.
The same number at different offices is allowed and matching may need review.

Prisma box creates/edits serialize management writes and lock the destination
office, sharing that lock with review-driven creation. Duplicate checks and
record/audit writes commit together. Office create/edit/archive and box archive
also commit their audit records atomically.

## Removal policy

- Delete is a soft archive, not destruction of historical records.
- Removing an office archives all its boxes in the same transaction.
- Existing mail/parcel flags, notification timestamps, mail events, collection
  events and audit records are retained. Archive does not pretend mail was collected.
- Archived offices/boxes disappear from active lists and waiting counts, and
  cannot be selected for new matching or collection.
- Pending review items remain visible and unread; archive neither resolves them
  nor queues source-email acknowledgement. Resolve them against another active
  box or explicitly ignore them in Needs Review.
- Archived box numbers remain reserved at their original office to prevent
  accidental reuse of historical identities. There is no self-service restore
  screen yet; restoration requires administrator database maintenance. Do not
  delete history to work around a duplicate-number error.
- Historical event IDs survive archive; older UI history may fall back to an ID
  when an archived box no longer appears in the active dashboard.

## Directory and forms

Search ranks exact/prefix matches before word-start matches, then contains
matches. Multiword word-start matches are supported. Selecting a suggestion
populates name, address, phone and coordinates. Stale search responses cannot
replace suggestions for a newer query. Failed edits stay open with entered
values intact; clearing an office phone number is supported.

Management lists use the full available width. Add forms sit below the list;
office and box edit fields wrap to fit their container without covering controls.

## Verification

`npm test` plus an explicit disposable `POBOX_TEST_DATABASE_URL` covers concurrent
normalized duplicate creation, office-only moves, permissions, validation,
persistence, preserved history/review after archive and directory ranking.

After building, start `server/tests/support/reviewBrowserServer.ts` as described
in [review-workflow.md](review-workflow.md). Run
`REVIEW_SESSION=<fixture-session> node scripts/verify-management-browser.mjs`
with Playwright installed, or set `PLAYWRIGHT_MODULE` to its index.mjs path.
This uses real local management APIs with synthetic authentication and directory
transport, not live LCTR credentials or the VPS. It checks directory population,
stale responses, multiple boxes, duplicate validation, collection, edit retry,
responsive layouts and archive confirmation. Stop the fixture after testing.

No schema migration is added by this change.
