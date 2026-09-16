# pobox.watch 1.0.0-rc.1 Production Readiness Audit

Date: 17 September 2026

## Scope

The audit covered the TypeScript API, React web app, Prisma schema and migrations,
deployment checks, browser workflows, Swift package, macOS target, and iOS target.

## Findings resolved

- Updated Vitest to remove the two moderate development dependency advisories.
- Added semantic prerelease version comparison and the 1.0.0-rc.1 release notes.
- Added cache controls so API and HTML responses stay fresh while hashed assets are immutable.
- Reduced dashboard latency by parallelising independent reads and avoiding redundant polling
  while the realtime connection is healthy.
- Added workspace and date indexes for the highest-frequency dashboard, history, and audit queries.
- Restricted Vitest discovery to source tests so compiled tests are not run twice.
- Updated browser verification for the public home page and authenticated `/app/` route.
- Added the macOS application category and aligned native marketing versions with 1.0 RC1.
- Corrected map-card metadata layout so phone and geofence details remain readable.

## Verification completed

- Dependency audit: no known vulnerabilities at moderate severity or higher.
- Server tests: 151 passed; 26 PostgreSQL integration tests skipped without `TEST_DATABASE_URL`.
- Type checking: server and web passed.
- Production build: server and web passed.
- Deployment test suite: 9 passed.
- Browser workflows: review, management, multi-user, maps/releases, and security passed.
- Swift package tests: 5 passed.
- iOS Release simulator build without signing: passed.
- macOS Release build without signing: passed.
- Desktop and mobile screenshots were inspected for layout regressions.

## External release gates

These checks require production services or credentials and are not proven by the local audit:

- Run the PostgreSQL integration suite against a disposable database using `TEST_DATABASE_URL`.
- Verify Gmail OAuth, one scheduled poll, message acknowledgement, and resulting mailbox state.
- Verify Apple MapKit with the production token; the OpenStreetMap fallback is covered locally.
- Sign and install the iOS and macOS builds with the Apple Developer team configuration.
- Deploy the exact RC1 commit, then verify migrations, PM2 listener, local/public health, public
  asset hashes, authenticated workflows, and native authentication return.

The repository is ready to be treated as an RC1 code candidate. It is not production-approved
until the external release gates above have been completed against the release commit.
