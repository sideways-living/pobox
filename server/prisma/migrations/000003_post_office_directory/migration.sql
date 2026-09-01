CREATE TABLE "PostOfficeDirectory" (
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT,
    "suburb" TEXT,
    "postcode" TEXT,
    "state" TEXT,
    "latitude" DECIMAL(65,30) NOT NULL,
    "longitude" DECIMAL(65,30) NOT NULL,
    "hours" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostOfficeDirectory_pkey" PRIMARY KEY ("sourceId")
);

CREATE TABLE "IntegrationSyncState" (
    "key" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationSyncState_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "PostOfficeDirectory_suburb_idx" ON "PostOfficeDirectory"("suburb");
CREATE INDEX "PostOfficeDirectory_postcode_idx" ON "PostOfficeDirectory"("postcode");
CREATE INDEX "PostOfficeDirectory_state_idx" ON "PostOfficeDirectory"("state");
CREATE INDEX "PostOfficeDirectory_active_idx" ON "PostOfficeDirectory"("active");
