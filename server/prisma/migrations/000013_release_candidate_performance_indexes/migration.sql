CREATE INDEX "PostOffice_workspaceId_active_name_idx"
  ON "PostOffice"("workspaceId", "active", "name");

CREATE INDEX "MailEvent_workspaceId_processedAt_idx"
  ON "MailEvent"("workspaceId", "processedAt");

CREATE INDEX "CollectionEvent_workspaceId_collectedAt_idx"
  ON "CollectionEvent"("workspaceId", "collectedAt");

CREATE INDEX "AuditEvent_workspaceId_eventType_createdAt_idx"
  ON "AuditEvent"("workspaceId", "eventType", "createdAt");

CREATE INDEX "AuditEvent_workspaceId_entityId_eventType_idx"
  ON "AuditEvent"("workspaceId", "entityId", "eventType");
