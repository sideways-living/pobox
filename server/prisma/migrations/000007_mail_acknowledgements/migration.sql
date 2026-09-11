CREATE TABLE "MailAcknowledgement" (
  "workspaceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("workspaceId", "provider", "providerMessageId")
);
CREATE INDEX "MailAcknowledgement_pending_idx" ON "MailAcknowledgement"
  ("workspaceId", "provider", "acknowledgedAt", "nextAttemptAt");

-- Existing messages are adopted on their next unread poll. Do not mark the
-- historical inbox read en masse or infer provider identity from thread IDs.
