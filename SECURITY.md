# Security

## Authentication

The web app uses a secure HTTP-only cookie session. Native clients should store refresh/session material in Keychain only. Passwords are hashed with Argon2id.

## Authorization

Every protected API resolves the authenticated session, active user, active workspace membership, requested workspace, object ownership, and required role. Clients cannot submit `collectedBy`; the backend derives the actor.

## Tenant Isolation

Workspace IDs in URLs are treated as requested scope, not proof of access. REST and WebSocket routes reject users without an active membership in that workspace.

## Passkeys

The schema stores public WebAuthn credential data only: credential ID, public key, counter/sign metadata, transports, friendly name, and timestamps. Private key material is never stored server-side. Production registration/login must be enabled only with correct HTTPS RP ID/origin settings.

## Secrets

Do not commit `.env` files or credentials. OAuth refresh tokens and IMAP credential references must be encrypted at rest. Logs must not include passwords, session secrets, access tokens, SMTP credentials, or full private email bodies.

## Web Protections

Nginx and Fastify are configured for HTTPS, secure headers, credentialed CORS for a configured origin, rate limiting on sensitive auth endpoints, strict DTO validation, and parameterized ORM access through Prisma.
