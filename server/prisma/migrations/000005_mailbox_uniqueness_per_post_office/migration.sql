DROP INDEX "Mailbox_workspaceId_boxNumber_key";
CREATE UNIQUE INDEX "Mailbox_workspaceId_postOfficeId_boxNumber_key" ON "Mailbox"("workspaceId", "postOfficeId", "boxNumber");
