import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, MemoryStore } from "../src/store/memoryStore.js";

describe("shared mailbox state", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.seedDemo();
  });

  it("deduplicates provider messages, not mailbox days", async () => {
    const daniel = await store.login("daniel@example.com", "Password123!");
    const first = store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-1",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 1234"
    });
    expect(first.kind).toBe("processed");
    expect(store.outstandingMailboxCount("ws_company")).toBe(1);

    const duplicate = store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-1",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 1234"
    });
    expect(duplicate.kind).toBe("duplicate");
    expect(store.outstandingMailboxCount("ws_company")).toBe(1);

    store.collectMailbox(daniel, "ws_company", "box_1234", "WEB");
    expect(store.outstandingMailboxCount("ws_company")).toBe(0);

    const later = store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-2",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 1234"
    });
    expect(later.kind).toBe("processed");
    expect(store.outstandingMailboxCount("ws_company")).toBe(1);
  });

  it("derives collection actor from authenticated session", async () => {
    const john = await store.login("john@example.com", "Password123!");
    store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-3",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 5678"
    });
    const event = store.collectMailbox(john, "ws_company", "box_5678", "WEB");
    expect(event.collectedBy).toBe("usr_john");
  });

  it("rejects member-only admin operations", async () => {
    const sarah = await store.login("sarah@example.com", "Password123!");
    expect(() => store.inviteMember(sarah, "ws_company", "alex@example.com", "MEMBER")).toThrow("Admin role required.");
  });

  it("makes simultaneous collection idempotent", async () => {
    const sarah = await store.login("sarah@example.com", "Password123!");
    const daniel = await store.login("daniel@example.com", "Password123!");
    store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-4",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box 882"
    });
    store.collectMailbox(sarah, "ws_company", "box_882", "IPHONE");
    expect(() => store.collectMailbox(daniel, "ws_company", "box_882", "MACOS")).toThrow(ConflictError);
  });
});
