CREATE TABLE "CollectionClaim" (
    "postOfficeId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "claimedBy" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionClaim_pkey" PRIMARY KEY ("postOfficeId")
);

CREATE INDEX "CollectionClaim_workspaceId_expiresAt_idx" ON "CollectionClaim"("workspaceId", "expiresAt");
CREATE INDEX "CollectionClaim_claimedBy_idx" ON "CollectionClaim"("claimedBy");

ALTER TABLE "CollectionClaim" ADD CONSTRAINT "CollectionClaim_postOfficeId_fkey" FOREIGN KEY ("postOfficeId") REFERENCES "PostOffice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionClaim" ADD CONSTRAINT "CollectionClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionClaim" ADD CONSTRAINT "CollectionClaim_claimedBy_fkey" FOREIGN KEY ("claimedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
