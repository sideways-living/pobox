# Maps, directory refresh and release updates

## Maps

Set `VITE_MAPKIT_TOKEN` before building the web workspace, with an Apple Maps token allowing the deployed website origin. Restarting PM2 alone cannot change this build-time value. The public browser token is not an Apple private signing key; never put a `.p8` key into a Vite variable.

The installed Apple loader uses MapKit JS 6. CSP permits its CDN, blob workers and WebAssembly compilation (`wasm-unsafe-eval`, not unrestricted `unsafe-eval`). See [Apple's loading and CSP guidance](https://developer.apple.com/documentation/mapkitjs/loading-the-latest-version-of-mapkit-js) and [initialization events](https://developer.apple.com/documentation/mapkitjs/handling-initialization-events).

Missing tokens, loading failures, a 15-second timeout and configuration errors retain Apple Maps location links. Only admins see setup diagnostics. Invalid coordinates use address search instead of an invalid coordinate link. Native Map pages currently open Apple Maps; they are not embedded native map canvases. Their shared URL helper preserves latitude/longitude order and supports address fallback.

`scripts/verify-maps-releases-browser.mjs` uses isolated sessions and a simulated Apple transport to test adapter behavior, configuration errors, responsive layouts and release dismissal. Run once against a build with `VITE_MAPKIT_TOKEN=fixture-mapkit-token`, then against a normal token-free build with `MAPKIT_MISSING=1`. It does not establish that a production token is valid or Apple tiles load. Verify those on the deployed origin with a real restricted token and browser network/CSP inspection. Restore the normal build after testing.

## Directory refresh

The imported directory is separate from user-managed `PostOffice` records. Refresh never overwrites saved office names, addresses, phone numbers, coordinates, boxes or history.

Search triggers a background refresh when the last successful attempt is at least seven days old. Admins can request a refresh directly. There is no requirement for the app to remain open during a running server import; there is no independent weekly scheduler when the app is unused. Failed automatic attempts back off for 15 minutes. Existing records remain searchable.

An atomic database lease permits one fetch worker, with takeover after 30 minutes if it crashes. Each upstream page has a 20-second timeout. Empty, malformed, invalid-coordinate and pagination-limit results fail closed. A complete response is published in one transaction: upsert source IDs, archive unseen directory rows and record success. A failure rolls back the publication and records `failed` plus a message; a replaced worker cannot publish or overwrite the newer worker's status. `IntegrationSyncState` stores the most recent attempt/outcome, not an append-only log. Its `syncedAt` is the attempt timestamp on failure/running and completion timestamp on success. `rowCount` retains the last successful count; the UI shows failures even when old locations exist.

## Release notes

GET `/app/changes` is read-only. Explicit dismissal sends the version the user actually saw; the backend accepts known older versions so an open tab is still dismissible after a deployment. Unknown and missing versions are rejected. Seen state is per user across devices and advances monotonically under a PostgreSQL row lock. Notes newer than that version are filtered by the user's workspace role. Merely logging in, fetching, closing a window or failing to save dismissal does not acknowledge notes.

Web errors stay inside the popup for retry. Native apps show the same notes and persist only after Got It; interactive sheet dismissal is disabled. Native maps/model tests and builds do not substitute for physical-device UI testing.

Release 0.13.8 needs no new Prisma migration. Deploy the web/backend and rebuild the native apps; use the existing hardened deployment script. Live Apple authorization and a full production LCTR import remain external validation steps.
