# Password changes and recovery

Users can change their password in Settings by providing the current password.
An authenticated session with completed passkey/2FA setup is required. Success
revokes all sessions, pending login challenges and reset links. Passkeys,
authenticators and recovery codes remain configured. The user signs in again.

Forgot Password is available from web/native login and Settings. The native link
opens the web reset flow. Reset links expire after 30 minutes, work once and are
stored as SHA-256 hashes. Issuing another link invalidates earlier links. A reset
does not grant a session, reactivate a disabled/deleted membership or bypass 2FA.
The token is in the URL fragment, not server request logs, and is cleared from the
browser address bar when the form opens. Existing history and audit attribution
are retained. Passwords must contain 12 to 200 characters.

## Email configuration

Set `SMTP_HOST`, `SMTP_PORT` (587 for STARTTLS or 465 for TLS), `SMTP_USER`,
`SMTP_PASSWORD` and `SMTP_FROM` in the VPS `.env`. Use a verified sender supported
by your provider and preserve `APP_BASE_URL=https://pobox.watch`. TLS is required.
Never put SMTP credentials in Vite variables or Git. The incoming Gmail polling
connection is separate from outbound email delivery.

If SMTP is absent, the app explicitly says email reset is not configured. For
configured requests, the response does not disclose whether an account exists.
Delivery failures are logged without credentials or reset URLs. Request another
link or contact the administrator if mail does not arrive. Check provider sender
verification, SPF/DKIM and spam delivery before enabling recovery for real users.

Deploy migration `000010_password_reset`, regenerate Prisma, build and restart.
Verify a real inbox reset, token reuse rejection and sign-in with 2FA afterwards.
SMTP credentials and a live delivery test are external setup steps.
