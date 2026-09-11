# Workspace permissions and live updates

## Boundaries

Every workspace API and websocket subscription requires an unexpired active-user session, completed passkey/2FA security, and ACTIVE membership in the URL workspace. Workspace reads (dashboard, history, review queue, team directory and public post-office directory) are available to members. Collection is available to members. Office/box administration, team changes, review decisions, invitations and directory synchronization require ADMIN. Auth routes operate on the session's own user, not a supplied user ID. Native handoff currently selects the existing `ws_company` workspace.

Store queries constrain records to the supplied workspace, including IDs received through other workspaces' routes. The directory is intentionally shared public location data. Gmail polling uses a server-configured workspace/provider; provider message fields cannot override that configuration. Background ingestion has no end-user session and is not exposed as a public ingestion route. Configure each mailbox source explicitly for the correct workspace.

Disabling/deleting a user changes the selected membership, not global User.active. Global inactivity still denies all access. A shared account's email/name cannot be changed by an administrator of just one workspace; role/status can be changed in that workspace. Users with no active memberships cannot password-login. Historical collection and audit rows retain the same user ID, profile and attribution; deletion here means removal of workspace access, not erasure of the account.

## Concurrent changes

Post-office and PO box edits and collection requests require `expectedUpdatedAt` from the displayed record. User edits require the team row's `expectedVersion`. Missing preconditions are rejected with 400; stale preconditions with 409. Web edit drafts keep the version from when editing began, even when live data refreshes underneath them. A failed save stays open. Cancel, refresh, review the current data, then edit again.

PostgreSQL management writes serialize within a workspace and recheck membership/role inside the transaction after acquiring the lock. This includes collection and review resolution. Two administrators cannot concurrently remove each other and leave no active admin. Box updates also use a database compare-and-update to detect intervening mail changes. Only one concurrent collection clears waiting flags and creates the collection event. A stale collection cannot clear a later notification. Existing review message locks preserve one decision and reject conflicting resolutions while scheduling durable email acknowledgements.

Archive/delete operations preserve history rather than implementing destructive erasure. They do not currently require edit-version preconditions. In-process memory storage is for demos/tests, not multi-worker persistence.

## Refresh behavior

Websocket broadcasts contain only `workspace.changed`, never a caller's dashboard snapshot, currentUser, role or private session data. Each client reloads under its own credentials. The hub checks authorization before delivery and every 15 seconds; revoked clients close with code 1008. Mail polling sends invalidations after durable processing, including newly queued review items.

The web reconnects with bounded exponential backoff, reloads on reconnect and has a 30-second catch-up poll for missed notifications or separate API processes. Refresh generations prevent late responses from overwriting a newer refresh/logout. The native apps refresh every 30 seconds while their signed-in view remains active, and retain manual refresh. They send record versions with writes and clear private views on dashboard authorization failure. Native refresh is polling, not an operating-system background push service.

Immediate socket fan-out is process-local. A shared pub/sub bus is still needed before claiming instant multi-process push; catch-up polling provides eventual refresh. In-flight authorized reads can finish during a permission change; subsequent reads/writes and deliveries are denied. Physical-device offline/foreground transitions are not covered by command-line native builds.

## Verification and deployment

Tests cover foreign-workspace route access/resource IDs, member/admin separation, shared-user removal with historical attribution, stale form and team updates, socket identity isolation and revoked subscriptions. Disposable PostgreSQL tests cover concurrent edits, collection, review decisions and competing administrator removals. `scripts/verify-multiuser-browser.mjs` verifies two browser identities, a preserved stale draft, offline/reconnect catch-up and removal returning to sign-in. Its login response is fixture setup; workspace requests and sockets are real local endpoints.

Deploy web/backend and rebuilt native apps together as 0.13.7. There is no new database migration in this release; retain and apply prior migrations, including 0.13.6 session security. Old clients lacking write preconditions fail closed and must update. No live deployment is performed by these checks.
