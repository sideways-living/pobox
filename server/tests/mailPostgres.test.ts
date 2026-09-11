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

  it("atomically creates a missing box and resolves, including repeat submission", async () => {
    await first.processIncomingMail(mail("missing", "Mail2Day: PO Box 3020 has mail"));
    const [review] = await first.listReviewItems(session, workspaceId);
    const office = await prisma.postOffice.findFirstOrThrow({ where: { workspaceId } });
    const input = { postOfficeId: office.id, boxNumber: "3020" };
    const results = await Promise.all([first.resolveReviewItem(session, workspaceId, review.id, "", input), second.resolveReviewItem(session, workspaceId, review.id, "", input)]);
    expect(results.map((result) => result.kind).sort()).toEqual(["duplicate", "processed"]);
    expect(await prisma.mailbox.count({ where: { workspaceId, boxNumber: "3020" } })).toBe(1);
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(1);
    expect(await first.pendingMailAcknowledgements(workspaceId, "gmail")).toEqual(["missing"]);
    expect(await prisma.auditEvent.count({ where: { workspaceId, eventType: "mail.needs_review" } })).toBe(1);
  });

  it("rolls back box creation when resolution cannot be committed", async () => {
    await first.processIncomingMail(mail("missing", "Mail2Day: PO Box 3020 has mail"));
    const [review] = await first.listReviewItems(session, workspaceId);
    const office = await prisma.postOffice.findFirstOrThrow({ where: { workspaceId } });
    const failing = prisma.$extends({ query: { mailAcknowledgement: { async upsert() { throw new Error("queue unavailable"); } } } });
    await expect(new PrismaStore(failing as unknown as PrismaClient).resolveReviewItem(session, workspaceId, review.id, "", { postOfficeId: office.id, boxNumber: "3020" })).rejects.toThrow("queue unavailable");
    expect(await prisma.mailbox.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(0);
    expect(await first.listReviewItems(session, workspaceId)).toHaveLength(1);
  });

  it("does not create an orphan box when a second administrator ignores concurrently", async () => {
    await first.processIncomingMail(mail("race", "Unknown"));
    const [review] = await first.listReviewItems(session, workspaceId);
    const office = await prisma.postOffice.findFirstOrThrow({ where: { workspaceId } });
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", memberships: { create: { workspaceId, role: "ADMIN", status: "ACTIVE" } } } });
    users.push(user.id);
    const outcomes = await Promise.allSettled([
      first.resolveReviewItem(session, workspaceId, review.id, "", { postOfficeId: office.id, boxNumber: "3020" }),
      second.dismissReviewItem({ ...session, userId: user.id }, workspaceId, review.id)
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.mailbox.count({ where: { workspaceId, boxNumber: "3020" } })).toBe(await prisma.mailEvent.count({ where: { workspaceId } }));
    expect(await first.listReviewItems(session, workspaceId)).toHaveLength(0);
    expect(await prisma.auditEvent.count({ where: { workspaceId, eventType: { in: ["mail.review_resolved", "mail.review_ignored"] } } })).toBe(1);
  });

  it("keeps old unresolved reviews visible and scopes decisions by provider", async () => {
    await first.processIncomingMail(mail("same", "Unknown"));
    await first.processIncomingMail({ ...mail("same", "Unknown"), provider: "imap" });
    const reviews = await first.listReviewItems(session, workspaceId);
    await first.dismissReviewItem(session, workspaceId, reviews.find((item) => item.provider === "gmail")!.id);
    await prisma.auditEvent.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ workspaceId, actorUserId: "system", eventType: "mail.needs_review", entityType: "mail_message", entityId: `later-${i}`, metadata: { provider: "gmail" } })) });
    const remaining = await first.listReviewItems(session, workspaceId);
    expect(remaining).toHaveLength(106);
    expect(remaining.some((item) => item.provider === "imap" && item.providerMessageId === "same")).toBe(true);
  });

  it("serializes normalized duplicate creates and permits different numbers at one office", async () => {
    const office = await prisma.postOffice.findFirstOrThrow({ where: { workspaceId } });
    const outcomes = await Promise.allSettled([
      first.createMailbox(session, workspaceId, { postOfficeId: office.id, boxNumber: "PO Box AB-12" }),
      second.createMailbox(session, workspaceId, { postOfficeId: office.id, boxNumber: "ab12" })
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    await first.createMailbox(session, workspaceId, { postOfficeId: office.id, boxNumber: "3020" });
    expect(await prisma.mailbox.count({ where: { workspaceId } })).toBe(3);
  });

  it("rejects duplicate office-only moves and persists office details across clients", async () => {
    const office = await first.createPostOffice(session, workspaceId, { name: "South Melbourne LPO", address: "181 Clarendon Street, South Melbourne VIC 3205", phone: "+61 3 9000 0000", latitude: -37.832, longitude: 144.96, geofenceRadius: 200 });
    await first.createMailbox(session, workspaceId, { postOfficeId: office.id, boxNumber: "1234" });
    await expect(second.updateMailbox(session, workspaceId, mailboxId, { postOfficeId: office.id })).rejects.toThrow("already has");
    await first.updatePostOffice(session, workspaceId, office.id, { phone: "+61 3 9000 1111" });
    const snapshot = await second.dashboard(session, workspaceId);
    expect(snapshot.postOffices.find((item) => item.id === office.id)).toMatchObject({ address: "181 Clarendon Street, South Melbourne VIC 3205", phone: "+61 3 9000 1111", latitude: -37.832, longitude: 144.96 });
  });

  it("archives boxes without deleting history, clearing flags or resolving pending reviews", async () => {
    await first.processIncomingMail(mail("history"));
    await first.processIncomingMail(mail("pending-review", "Unknown destination"));
    await first.deleteMailbox(session, workspaceId, mailboxId);
    expect(await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } })).toMatchObject({ active: false, mailWaiting: true });
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(1);
    expect(await second.listReviewItems(session, workspaceId)).toHaveLength(1);
    expect(await second.pendingMailAcknowledgements(workspaceId, "gmail")).toEqual(["history"]);
    expect(await second.outstandingMailboxCount(workspaceId)).toBe(0);
    const office = await prisma.postOffice.findFirstOrThrow({ where: { workspaceId } });
    await expect(first.createMailbox(session, workspaceId, { postOfficeId: office.id, boxNumber: "1234" })).rejects.toThrow("archived record");
  });

  it("archives the entire office atomically and rejects future additions", async () => {
    const office = await prisma.postOffice.findFirstOrThrow({ where: { workspaceId } });
    await first.createMailbox(session, workspaceId, { postOfficeId: office.id, boxNumber: "3020" });
    await first.processIncomingMail(mail("history"));
    await first.deletePostOffice(session, workspaceId, office.id);
    expect(await second.dashboard(session, workspaceId)).toMatchObject({ postOffices: [] });
    expect(await prisma.mailbox.count({ where: { workspaceId, active: true } })).toBe(0);
    expect(await prisma.mailEvent.count({ where: { workspaceId } })).toBe(1);
    await expect(second.createMailbox(session, workspaceId, { postOfficeId: office.id, boxNumber: "999" })).rejects.toThrow("Post office not found");
    expect(await prisma.auditEvent.count({ where: { workspaceId, eventType: "post_office.deleted" } })).toBe(1);
  });

  it("allows one simultaneous edit and rejects the stale competing edit", async () => {
    const box = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
    const results = await Promise.allSettled([
      first.updateMailbox(session, workspaceId, mailboxId, { boxNumber: "8001", expectedUpdatedAt: box.updatedAt.toISOString() }),
      second.updateMailbox(session, workspaceId, mailboxId, { boxNumber: "8002", expectedUpdatedAt: box.updatedAt.toISOString() })
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(item => item.status === "rejected")).toHaveLength(1);
  });

  it("records one simultaneous collection and rejects stale collection after new mail", async () => {
    await first.processIncomingMail(mail("first"));
    const box = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
    const results = await Promise.allSettled([
      first.collectMailbox(session, workspaceId, mailboxId, "WEB", box.updatedAt.toISOString()),
      second.collectMailbox(session, workspaceId, mailboxId, "WEB", box.updatedAt.toISOString())
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.collectionEvent.count({ where: { workspaceId, mailboxId } })).toBe(1);
    await first.processIncomingMail(mail("new-mail"));
    await expect(second.collectMailbox(session, workspaceId, mailboxId, "WEB", box.updatedAt.toISOString())).rejects.toThrow("changed");
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } })).mailWaiting).toBe(true);
  });

  it("serializes competing admin removals and preserves an active administrator", async () => {
    const otherAdmin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", memberships: { create: { workspaceId, role: "ADMIN", status: "ACTIVE" } } } });
    users.push(otherAdmin.id);
    const otherSession = { ...session, userId: otherAdmin.id };
    const results = await Promise.allSettled([
      first.updateUser(session, workspaceId, otherAdmin.id, { status: "DISABLED" }),
      second.updateUser(otherSession, workspaceId, session.userId, { status: "DISABLED" })
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.workspaceMember.count({ where: { workspaceId, role: "ADMIN", status: "ACTIVE" } })).toBe(1);
  });

  it("removes only the chosen membership and preserves collection attribution", async () => {
    const anotherWorkspace = randomUUID(); workspaces.push(anotherWorkspace);
    await prisma.workspace.create({ data: { id: anotherWorkspace, name: "Other workspace" } });
    const shared = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", memberships: { create: [{ workspaceId, role: "MEMBER", status: "ACTIVE" }, { workspaceId: anotherWorkspace, role: "MEMBER", status: "ACTIVE" }] } } });
    users.push(shared.id);
    const sharedSession = { ...session, userId: shared.id };
    await first.processIncomingMail(mail("attribution"));
    const collection = await first.collectMailbox(sharedSession, workspaceId, mailboxId, "WEB");
    await first.deleteUser(session, workspaceId, shared.id);
    await expect(second.requireMember(sharedSession, workspaceId)).rejects.toThrow();
    expect((await second.requireMember(sharedSession, anotherWorkspace)).status).toBe("ACTIVE");
    expect((await prisma.collectionEvent.findUniqueOrThrow({ where: { id: collection.id } })).collectedBy).toBe(shared.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: shared.id } })).active).toBe(true);
    await expect(first.updateUser(session, workspaceId, shared.id, { email: "hijack@example.test" })).rejects.toThrow("Shared account");
  });
});
