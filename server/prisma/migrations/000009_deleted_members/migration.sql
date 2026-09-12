ALTER TABLE "WorkspaceMember" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Preserve earlier explicit deletions, but not users disabled without deletion.
UPDATE "WorkspaceMember" AS member
SET "deletedAt" = deletion."createdAt"
FROM (
  SELECT "workspaceId", "entityId", MAX("createdAt") AS "createdAt"
  FROM "AuditEvent"
  WHERE "eventType" = 'member.deleted' AND "entityType" = 'user'
  GROUP BY "workspaceId", "entityId"
) AS deletion
WHERE member."workspaceId" = deletion."workspaceId"
  AND member."userId" = deletion."entityId"
  AND member.status = 'DISABLED'
  AND NOT EXISTS (
    SELECT 1 FROM "AuditEvent" AS later
    WHERE later."workspaceId" = member."workspaceId"
      AND later."entityId" = member."userId"
      AND later."entityType" = 'user'
      AND later."eventType" = 'member.updated'
      AND later."createdAt" > deletion."createdAt"
  );
