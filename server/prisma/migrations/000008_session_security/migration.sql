ALTER TABLE "Session" ADD COLUMN "secondFactorVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "totpPendingSessionId" TEXT;
ALTER TABLE "User" ADD COLUMN "totpPendingExpiresAt" TIMESTAMP(3);
-- Require existing clients to sign in again rather than assume prior 2FA proof.
DELETE FROM "Session";
