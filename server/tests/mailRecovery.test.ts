import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memoryStore.js";
import { MailPoller } from "../src/mail/poller.js";
import { MailAuthenticationError, safeMailError, withMailRetry } from "../src/mail/retry.js";
import { createStore } from "../src/store/factory.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const message = { providerMessageId: "message", subject: "Mail2Day: PO Box 1234 has mail", sender: "alerts@example.com" };
const options = { workspaceId: "ws_company", intervalMs: 1800000 };

async function setup() {
  const store = new MemoryStore();
  await store.seedDemo();
  const provider = { providerName: "gmail", listUnreadMessages: vi.fn(async () => [message]), markMessageRead: vi.fn(async (_id: string) => {}) };
  return { store, provider, poller: new MailPoller({ store, provider }, options) };
}

describe("mail failure recovery", () => {
  it("refuses volatile storage in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POBOX_WATCH_STORAGE", "memory");
    expect(() => createStore()).toThrow("durable mail processing");
  });
  it("does not acknowledge a failed import and continues with the next message", async () => {
    const { store, provider, poller } = await setup();
    provider.listUnreadMessages.mockResolvedValue([message, { ...message, providerMessageId: "next" }]);
    vi.spyOn(store, "processIncomingMail").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(poller.pollOnce()).resolves.toMatchObject({ processed: 1, markedRead: 1, failed: 1 });
    expect(provider.markMessageRead).toHaveBeenCalledExactlyOnceWith("next");
    await expect(poller.pollOnce()).resolves.toMatchObject({ processed: 1 });
    expect(store.mailEvents.size).toBe(2);
  });

  it("retries a failed acknowledgement after restart, even when listing no longer returns the email", async () => {
    const { store, provider, poller } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    provider.markMessageRead.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(poller.pollOnce()).resolves.toMatchObject({ processed: 1, markedRead: 0, failed: 1 });
    expect(store.mailEvents.size).toBe(1);
    provider.listUnreadMessages.mockResolvedValue([]);
    const restarted = new MailPoller({ store, provider }, options);
    await expect(restarted.pollOnce()).resolves.toMatchObject({ markedRead: 0 });
    vi.setSystemTime(Date.now() + 61000);
    await expect(restarted.pollOnce()).resolves.toMatchObject({ markedRead: 1, failed: 0 });
    expect(store.mailEvents.size).toBe(1);
    expect(await store.pendingMailAcknowledgements("ws_company", "gmail")).toEqual([]);
  });

  it("safely retries when Gmail succeeded but saving acknowledgement failed", async () => {
    const { store, provider, poller } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(store, "acknowledgeMail").mockRejectedValueOnce(new Error("connection lost"));
    await expect(poller.pollOnce()).resolves.toMatchObject({ failed: 1 });
    provider.listUnreadMessages.mockResolvedValue([]);
    vi.setSystemTime(Date.now() + 61000);
    await expect(new MailPoller({ store, provider }, options).pollOnce()).resolves.toMatchObject({ markedRead: 1 });
    expect(provider.markMessageRead).toHaveBeenCalledTimes(2);
    expect(store.mailEvents.size).toBe(1);
  });

  it("keeps pending work after expired credentials and recovers after reconnect", async () => {
    const { store, provider, poller } = await setup();
    await store.processIncomingMail({ ...message, workspaceId: "ws_company", provider: "gmail" });
    vi.useFakeTimers({ toFake: ["Date"] });
    provider.markMessageRead.mockRejectedValueOnce(new MailAuthenticationError());
    await expect(poller.pollOnce()).rejects.toBeInstanceOf(MailAuthenticationError);
    expect(provider.listUnreadMessages).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 61000);
    await expect(poller.pollOnce()).resolves.toMatchObject({ processed: 0, markedRead: 1 });
    expect(store.mailEvents.size).toBe(1);
  });

  it("skips overlapping polls and does not duplicate timer registration", async () => {
    const { provider, poller } = await setup();
    let release!: (value: typeof message[]) => void;
    provider.listUnreadMessages.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = poller.pollOnce();
    await expect(poller.pollOnce()).resolves.toMatchObject({ scanned: 0 });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release([message]);
    await expect(first).resolves.toMatchObject({ processed: 1 });
    vi.spyOn(poller, "pollOnce").mockResolvedValue({ scanned: 0, processed: 0, duplicates: 0, needsReview: 0, markedRead: 0, failed: 0 });
    const timer = vi.spyOn(globalThis, "setInterval");
    poller.start(); poller.start(); poller.stop();
    expect(timer).toHaveBeenCalledTimes(1);
  });

  it("acknowledges reviewed messages without requiring another unread search match", async () => {
    const { store, provider, poller } = await setup();
    provider.listUnreadMessages.mockResolvedValue([{ ...message, subject: "Unknown" }]);
    await poller.pollOnce();
    const login = await store.login("daniel@example.com", "Password123!");
    if (login.kind !== "session") throw new Error("Expected session");
    const [review] = await store.listReviewItems(login, "ws_company");
    await store.dismissReviewItem(login, "ws_company", review.id);
    provider.listUnreadMessages.mockRejectedValue(new Error("listing down"));
    await expect(poller.pollOnce()).rejects.toThrow("listing down");
    expect(provider.markMessageRead).toHaveBeenCalledExactlyOnceWith("message");
    expect(store.mailEvents.size).toBe(0);
  });
});

describe("bounded Gmail retries", () => {
  it.each([429, 500, 503, 408])("retries transient HTTP %s", async (status) => {
    const operation = vi.fn().mockRejectedValueOnce({ response: { status } }).mockResolvedValue("ok");
    const sleep = vi.fn(async () => {});
    await expect(withMailRetry(operation, sleep)).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("stops after three attempts", async () => {
    const operation = vi.fn().mockRejectedValue({ code: "ECONNRESET" });
    const sleep = vi.fn(async () => {});
    await expect(withMailRetry(operation, sleep)).rejects.toEqual({ code: "ECONNRESET" });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it.each([{ response: { status: 401 } }, { response: { status: 400, data: { error: "invalid_grant" } } }])("requires reconnect for revoked credentials", async (error) => {
    const operation = vi.fn().mockRejectedValue(error);
    await expect(withMailRetry(operation)).rejects.toBeInstanceOf(MailAuthenticationError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not log provider request headers, tokens or email content", () => {
    expect(safeMailError({ message: "Bearer SECRET email content", response: { status: 503 } })).toBe("Mail operation failed (HTTP 503); it will be retried.");
  });
});
