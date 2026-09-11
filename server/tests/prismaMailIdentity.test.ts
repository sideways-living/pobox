import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaStore } from "../src/store/prismaStore.js";

const input = { workspaceId: "workspace", provider: "gmail", providerMessageId: "message-2", providerThreadId: "thread", sender: "alerts@example.com", subject: "Unknown box" };

function fixture(events: Array<{ entityId: string; eventType: string; provider?: string; workspaceId?: string }>) {
  const auditEvent = {
    findMany: vi.fn(async () => events.map((event) => ({
      workspaceId: event.workspaceId ?? input.workspaceId,
      entityId: event.entityId,
      eventType: event.eventType,
      metadata: { provider: event.provider ?? "gmail", providerThreadId: "thread", notificationType: "PARCEL" }
    }))),
    create: vi.fn(async ({ data }) => ({ ...data, id: "review-new", createdAt: new Date() }))
  };
  const mailbox = { findMany: vi.fn(async () => []) };
  const prisma = { mailEvent: { findUnique: vi.fn(async () => null) }, auditEvent, mailbox, postOffice: { findMany: vi.fn(async () => []) } };
  return { store: new PrismaStore(prisma as unknown as PrismaClient), auditEvent, mailbox };
}

describe("Prisma incoming message review identity", () => {
  it("does not let an ignored message suppress a different message in the same thread", async () => {
    const { store, auditEvent } = fixture([
      { entityId: "message-1", eventType: "mail.needs_review" },
      { entityId: "message-1", eventType: "mail.review_ignored" }
    ]);
    await expect(store.processIncomingMail(input)).resolves.toMatchObject({ kind: "needs_review" });
    expect(auditEvent.create).toHaveBeenCalledOnce();
    expect(auditEvent.findMany.mock.calls[0]).toEqual([{ where: {
      workspaceId: "workspace", entityId: "message-2",
      eventType: { in: ["mail.needs_review", "mail.review_resolved", "mail.review_ignored", "mail.review_dismissed"] }
    }, orderBy: { createdAt: "desc" } }]);
  });

  it.each(["mail.review_resolved", "mail.review_ignored", "mail.review_dismissed", undefined])("preserves review state %s before reparsing", async (resolution) => {
    const events = [{ entityId: input.providerMessageId, eventType: "mail.needs_review" }];
    if (resolution) events.push({ entityId: input.providerMessageId, eventType: resolution });
    const { store, auditEvent, mailbox } = fixture(events);
    await expect(store.processIncomingMail(input)).resolves.toEqual({ kind: resolution ? "duplicate" : "needs_review", notificationType: "PARCEL" });
    expect(mailbox.findMany).not.toHaveBeenCalled();
    expect(auditEvent.create).not.toHaveBeenCalled();
  });

  it.each([{ provider: "imap" }, { workspaceId: "another-workspace" }])("keeps matching identities scoped to the provider and workspace: %j", async (scope) => {
    const { store, auditEvent } = fixture([{ entityId: input.providerMessageId, eventType: "mail.needs_review", ...scope }]);
    await store.processIncomingMail(input);
    expect(auditEvent.create).toHaveBeenCalledOnce();
  });
});
