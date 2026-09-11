# Security and account recovery

## Enforced flow

- Passkeys are the default. Password input is hidden until the fallback is chosen.
- Password or passkey proof creates a short-lived 2FA challenge for enrolled users; it does not grant a workspace session.
- Accounts without an authenticator receive a restricted setup session. Workspace APIs and realtime require a passkey, enabled authenticator, active membership, and verified 2FA on that specific session.
- Confirming initial authenticator setup verifies the current session and revokes other sessions. Another device completing setup cannot upgrade an old password-only session.
- Logout deletes server sessions for both current and legacy cookies. Expired sessions and inactive users are rejected. Realtime reauthorizes before sending data and every 15 seconds; web and native clients clear private views after session rejection.
- Authenticator verification accepts the existing adjacent 30-second clock windows. Login challenges are consumed once; recovery codes are consumed conditionally in the same PostgreSQL transaction as challenge consumption and session creation. Separate workers cannot both use one recovery code.

## Recovery

- Lost passkey: choose password fallback, then complete authenticator/recovery-code verification. Add a replacement passkey in Settings.
- Lost authenticator: sign in with a passkey or password and an unused recovery code. In Settings, enter another unused recovery code to start replacement. A current authenticator code can also authorize replacement.
- The old authenticator remains enabled until the new secret is confirmed. Pending setup expires after ten minutes and can only be confirmed by the session that started it. Confirmation is single-use, rotates all recovery codes, invalidates pending login challenges, and revokes other sessions. Store the newly displayed codes securely; old codes stop working.
- One recovery code is consumed when replacement starts, even if setup is abandoned. With only one code left, start replacement from an existing authenticated session rather than spending the last code on a new login.
- No automated password reset or administrator 2FA bypass exists. Losing both the authenticator and all recovery codes remains locked out. Do not disable 2FA through database edits or reuse another person's account. A separately designed, audited identity-verification process is needed for that case.
- Individual lost-passkey revocation is not yet exposed in Settings. A replacement passkey does not remove an old registered credential. Treat a stolen device as an incident; authenticator replacement revokes sessions but does not delete passkeys.

## Native handoff

The app generates a random verifier in memory and sends only its SHA-256 challenge to the web page, alongside a locally validated email hint. The hint is not authentication. The web page only returns to the allowlisted auth callback and issues a two-minute one-use code after full security checks. Redemption requires the device verifier and a still-authorized parent session. Invalid proof consumes the code; restart sign-in to retry. Codes live in one API process and fail closed after restart, so multi-process deployments need a shared handoff store before scaling.

Terminating the native app during browser sign-in loses the verifier; restart sign-in from the app. Old native builds cannot redeem the new handoff. Universal links and physical-device browser-to-app acceptance tests remain release checks; automated tests do not prove OS callback routing.

## Deploy 0.13.6

Apply migration `000008_session_security` before starting the new backend. It adds session verification state and deliberately deletes existing sessions. Back up first, stop the old PM2 process during migration/build, deploy backend/web together, then restart/save PM2. Distribute rebuilt iOS/macOS apps with the verifier-enabled handoff. Users must sign in again. Do not use `prisma db push` on the production database.

The repository's older initial migrations have a pre-existing duplicate PostOffice phone-column issue on empty databases. The disposable test database uses `db push`; that is not evidence of a clean full migration-chain deployment.

## Verification

`npm test` runs security API/store tests. Set `POBOX_TEST_DATABASE_URL` to a disposable PostgreSQL database to include competing-client recovery and confirmation tests. `scripts/verify-security-browser.mjs` uses real local auth endpoints and a Chrome virtual authenticator, not mocked login responses. Start `server/tests/support/securityBrowserServer.ts` with tsx after building. It binds loopback port 4190 and refuses production mode. Native proof generation has a Swift unit test.

Remaining audit boundaries: TOTP values themselves are accepted within the clock window and are not tracked as globally single-use across distinct challenges; per-account distributed throttling, security-event audit records, and individual credential/session management need further hardening. Development dependencies currently have two moderate Vitest-related advisories; `npm audit --omit=dev` reports no production advisories. Do not describe this pass as a completed independent security certification.
