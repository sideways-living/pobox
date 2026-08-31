CREATE TABLE "WebAuthnChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "type" TEXT NOT NULL,
  "challenge" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebAuthnChallenge_userId_type_expiresAt_idx" ON "WebAuthnChallenge"("userId", "type", "expiresAt");
CREATE INDEX "WebAuthnChallenge_challenge_type_idx" ON "WebAuthnChallenge"("challenge", "type");

ALTER TABLE "WebAuthnChallenge" ADD CONSTRAINT "WebAuthnChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
