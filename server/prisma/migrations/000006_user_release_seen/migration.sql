ALTER TABLE "User"
  ADD COLUMN "lastSeenReleaseVersion" TEXT,
  ADD COLUMN "lastSeenReleaseAt" TIMESTAMP(3);
