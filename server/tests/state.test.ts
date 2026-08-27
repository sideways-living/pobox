import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memoryStore.js";
import { ConflictError } from "../src/store/types.js";

describe("shared mailbox state", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.seedDemo();
  });

  it("deduplicates provider messages, not mailbox days", async () => {
    const daniel = await store.login("daniel@example.com", "Password123!");
    const first = await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-1",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 1234"
    });
    expect(first.kind).toBe("processed");
    await expect(store.outstandingMailboxCount("ws_company")).resolves.toBe(1);

    const duplicate = await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-1",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 1234"
    });
    expect(duplicate.kind).toBe("duplicate");
    await expect(store.outstandingMailboxCount("ws_company")).resolves.toBe(1);

    await store.collectMailbox(daniel, "ws_company", "box_1234", "WEB");
    await expect(store.outstandingMailboxCount("ws_company")).resolves.toBe(0);

    const later = await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-2",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 1234"
    });
    expect(later.kind).toBe("processed");
    await expect(store.outstandingMailboxCount("ws_company")).resolves.toBe(1);
  });

  it("derives collection actor from authenticated session", async () => {
    const john = await store.login("john@example.com", "Password123!");
    await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-3",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 5678"
    });
    const event = await store.collectMailbox(john, "ws_company", "box_5678", "WEB");
    expect(event.collectedBy).toBe("usr_john");
  });

  it("rejects member-only admin operations", async () => {
    const sarah = await store.login("sarah@example.com", "Password123!");
    await expect(store.inviteMember(sarah, "ws_company", "alex@example.com", "MEMBER")).rejects.toThrow("Admin role required.");
  });

  it("makes simultaneous collection idempotent", async () => {
    const sarah = await store.login("sarah@example.com", "Password123!");
    const daniel = await store.login("daniel@example.com", "Password123!");
    await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-4",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 882"
    });
    await store.collectMailbox(sarah, "ws_company", "box_882", "IPHONE");
    await expect(store.collectMailbox(daniel, "ws_company", "box_882", "MACOS")).rejects.toThrow(ConflictError);
  });
});
