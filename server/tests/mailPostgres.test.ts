import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaStore } from "../src/store/prismaStore.js";
import type { Session } from "../src/domain.js";

const url = process.env.POBOX_TEST_DATABASE_URL;

describe.skipIf(!url)("PostgreSQL mail durability and worker concurrency", () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const other = new PrismaClient({ datasourceUrl: url });
  const first = new PrismaStore(prisma);
  const second = new PrismaStore(other);
  let workspaceId: string;
  let mailboxId: string;
  let session: Session;
  const workspaces: string[] = [];
  const users: string[] = [];
  const mail = (id: string, subject = "Mail2Day: PO Box 1234 has mail") => ({ workspaceId, provider: "gmail", providerMessageId: id, providerThreadId: "thread", sender: "alerts@example.com", subject });

  beforeEach(async () => {
    // Only the explicitly provided disposable database is used. Each case owns
    // its workspace; cleanup never truncates shared application tables.
    workspaceId = randomUUID();
    workspaces.push(workspaceId);
    await prisma.workspace.create({ data: { id: workspaceId, name: "Mail reliability test" } });
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", memberships: { create: { workspaceId, role: "ADMIN", status: "ACTIVE" } } } });
    users.push(user.id);
    session = { id: "test-session", userId: user.id, expiresAt: new Date(Date.now() + 60000).toISOString() };
    const office = await prisma.postOffice.create({ data: { workspaceId, name: "Test Post Office", address: "Test address", latitude: 0, longitude: 0, geofenceRadius: 100 } });
    const box = await prisma.mailbox.create({ data: { workspaceId, postOfficeId: office.id, name: "PO Box 1234", boxNumber: "1234" } });
    mailboxId = box.id;
  });

  afterAll(async () => {
    const where = { workspaceId: { in: workspaces } };
    await prisma.$transaction([
      prisma.mailAcknowledgement.deleteMany({ where }), prisma.auditEvent.deleteMany({ where }),
      prisma.collectionEvent.deleteMany({ where }), prisma.mailEvent.deleteMany({ where }),
      prisma.mailbox.deleteMany({ where }), prisma.postOffice.deleteMany({ where }),
      prisma.workspaceMember.deleteMany({ where }), prisma.workspace.deleteMany({ where: { id: { in: workspaces } } }),
      prisma.user.deleteMany({ where: { id: { in: users } } })
    ]);
    await Promise.all([prisma.$disconnect(), other.$disconnect()]);
  });

  it("imports one notification once across independent database clients", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).processIncomingMail(mail("one"))));
    expect(results.filter((result) => result.kind === "processed")).toHaveLength(1);
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.mailAcknowledgement.count({ where: { workspaceId } })).toBe(1);
    expect(await first.outstandingMailboxCount(workspaceId)).toBe(1);
    await Promise.all([first.processIncomingMail(mail("day-two")), second.processIncomingMail(mail("day-three"))]);
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(3);
    expect(await first.outstandingMailboxCount(workspaceId)).toBe(1);
  });

  it("creates one review item when workers import an unmatched message together", async () => {
    await Promise.all([first.processIncomingMail(mail("review", "Unknown")), second.processIncomingMail(mail("review", "Unknown"))]);
    expect(await first.listReviewItems(session, workspaceId)).toHaveLength(1);
    expect(await first.pendingMailAcknowledgements(workspaceId, "gmail")).toEqual([]);
  });

  it("preserves independent flags when mail and parcel arrive on different workers", async () => {
    const box = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
    await prisma.postOffice.update({ where: { id: box.postOfficeId }, data: { name: "South Melbourne Local Post Office" } });
    await Promise.all([
      first.processIncomingMail({ ...mail("letter"), receivedAt: "2026-09-12T01:00:00.000Z" }),
      second.processIncomingMail({ ...mail("parcel", "Your PO Box item is ready to collect!"), bodyPreview: "Collect from:\nSOUTH MELBOURNE\nAddress: Example Street", receivedAt: "2026-09-12T02:00:00.000Z" })
    ]);
    expect(await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } })).toMatchObject({ mailWaiting: true, parcelWaiting: true, latestNotificationAt: new Date("2026-09-12T01:00:00.000Z"), latestParcelNotificationAt: new Date("2026-09-12T02:00:00.000Z") });
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(2);
    expect(await first.outstandingMailboxCount(workspaceId)).toBe(1);
  });

  it("rolls back the event, flag and audit if queuing acknowledgement fails", async () => {
    const failing = prisma.$extends({ query: { mailAcknowledgement: { async upsert() { throw new Error("simulated crash before commit"); } } } });
    await expect(new PrismaStore(failing as unknown as PrismaClient).processIncomingMail(mail("crash"))).rejects.toThrow("simulated crash");
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { workspaceId } })).toBe(0);
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } })).mailWaiting).toBe(false);
    await expect(second.processIncomingMail(mail("crash"))).resolves.toMatchObject({ kind: "processed" });
  });

  it("persists pending acknowledgement across clients and retries without another mail event", async () => {
    await first.processIncomingMail(mail("pending"));
    expect(await second.pendingMailAcknowledgements(workspaceId, "gmail")).toEqual(["pending"]);
    await second.failMailAcknowledgement(workspaceId, "gmail", "pending", "HTTP 503");
    expect(await first.pendingMailAcknowledgements(workspaceId, "gmail")).toEqual([]);
    await prisma.mailAcknowledgement.updateMany({ where: { workspaceId }, data: { nextAttemptAt: new Date(0) } });
    expect(await first.pendingMailAcknowledgements(workspaceId, "gmail")).toEqual(["pending"]);
    await first.acknowledgeMail(workspaceId, "gmail", "pending");
    await second.failMailAcknowledgement(workspaceId, "gmail", "pending", "late failure from another worker");
    expect(await second.pendingMailAcknowledgements(workspaceId, "gmail")).toEqual([]);
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(1);
  });

  it("commits exactly one competing review decision and queues its acknowledgement", async () => {
    await first.processIncomingMail(mail("review", "Unknown"));
    const [review] = await first.listReviewItems(session, workspaceId);
    const decisions = await Promise.allSettled([
      first.resolveReviewItem(session, workspaceId, review.id, mailboxId),
      second.dismissReviewItem(session, workspaceId, review.id)
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await first.listReviewItems(session, workspaceId)).toHaveLength(0);
    expect(await second.pendingMailAcknowledgements(workspaceId, "gmail")).toEqual(["review"]);
    expect(await prisma.auditEvent.count({ where: { workspaceId, eventType: { in: ["mail.review_resolved", "mail.review_ignored"] } } })).toBe(1);
  });

  it("rolls back a review decision when acknowledgement queueing fails", async () => {
    await first.processIncomingMail(mail("review", "Unknown"));
    const [review] = await first.listReviewItems(session, workspaceId);
    const failing = prisma.$extends({ query: { mailAcknowledgement: { async upsert() { throw new Error("simulated review crash"); } } } });
    await expect(new PrismaStore(failing as unknown as PrismaClient).resolveReviewItem(session, workspaceId, review.id, mailboxId)).rejects.toThrow("simulated review crash");
    expect(await first.listReviewItems(session, workspaceId)).toHaveLength(1);
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(0);
    await second.resolveReviewItem(session, workspaceId, review.id, mailboxId);
    await first.resolveReviewItem(session, workspaceId, review.id, mailboxId);
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(1);
  });
});
