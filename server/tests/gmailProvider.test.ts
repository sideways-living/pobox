import { beforeEach, describe, expect, it, vi } from "vitest";
import { GmailProviderClient } from "../src/mail/gmailProvider.js";
import { MailPoller } from "../src/mail/poller.js";
import { MemoryStore } from "../src/store/memoryStore.js";

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), modify: vi.fn() }));
vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    gmail: () => ({ users: { messages: api } })
  }
}));

const config = { clientId: "test", clientSecret: "test", refreshToken: "test", maxResults: 2 };

describe("Gmail unread pagination", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.get.mockImplementation(async ({ id }) => ({ data: {
      id, threadId: "shared-thread", internalDate: "1788307200000",
      payload: { headers: [{ name: "Subject", value: `Notification ${id}` }, { name: "From", value: "alerts@example.com" }] }
    } }));
  });

  it("reaches mail beyond a full page of unresolved unread items and deduplicates page overlap", async () => {
    api.list.mockResolvedValueOnce({ data: { messages: [{ id: "review-1" }, { id: "review-2" }], nextPageToken: "page-2" } })
      .mockResolvedValueOnce({ data: { messages: [{ id: "review-2" }, { id: "new-mail" }], nextPageToken: "page-3" } })
      .mockResolvedValueOnce({ data: { messages: [{ id: "new-parcel" }] } });
    const messages = await new GmailProviderClient(config).listUnreadMessages();
    expect(messages.map((message) => message.providerMessageId)).toEqual(["review-1", "review-2", "new-mail", "new-parcel"]);
    expect(api.list.mock.calls.map(([request]) => request.pageToken)).toEqual([undefined, "page-2", "page-3"]);
    expect(api.list).toHaveBeenLastCalledWith({ userId: "me", q: "is:unread", maxResults: 2, pageToken: "page-3" }, { timeout: 15000, retry: false });
    expect(api.get).toHaveBeenCalledTimes(4);
    expect(api.modify).not.toHaveBeenCalled();
    expect(messages.every((message) => message.providerThreadId === "shared-thread")).toBe(true);
  });

  it("follows an empty intermediate page", async () => {
    api.list.mockResolvedValueOnce({ data: { nextPageToken: "next" } })
      .mockResolvedValueOnce({ data: { messages: [{ id: "mail" }] } });
    expect(await new GmailProviderClient(config).listUnreadMessages()).toHaveLength(1);
  });

  it("processes later-page mail while leaving first-page review messages unread", async () => {
    api.list.mockResolvedValueOnce({ data: { messages: [{ id: "review" }], nextPageToken: "next" } })
      .mockResolvedValueOnce({ data: { messages: [{ id: "mail" }] } });
    api.get.mockImplementation(async ({ id }) => ({ data: {
      threadId: "shared-thread",
      payload: { headers: [{ name: "Subject", value: id === "mail" ? "Mail2Day: PO Box 1234 has mail" : "Unknown box" }] }
    } }));
    const store = new MemoryStore();
    await store.seedDemo();
    const poller = new MailPoller({ store, provider: new GmailProviderClient(config) }, { workspaceId: "ws_company", intervalMs: 1800000 });
    await expect(poller.pollOnce()).resolves.toEqual({ scanned: 2, processed: 1, duplicates: 0, needsReview: 1, markedRead: 1, failed: 0 });
    expect(api.modify).toHaveBeenCalledExactlyOnceWith({ userId: "me", id: "mail", requestBody: { removeLabelIds: ["UNREAD"] } }, { timeout: 15000, retry: false });
  });

  it("fails on a later page without acknowledging any source mail", async () => {
    api.list.mockResolvedValueOnce({ data: { messages: [{ id: "mail" }], nextPageToken: "next" } })
      .mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(new GmailProviderClient(config).listUnreadMessages()).rejects.toThrow("provider unavailable");
    expect(api.modify).not.toHaveBeenCalled();
  });

  it("rejects repeated pagination tokens instead of looping forever", async () => {
    api.list.mockResolvedValue({ data: { nextPageToken: "same" } });
    await expect(new GmailProviderClient(config).listUnreadMessages()).rejects.toThrow("repeated page token");
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("keeps fetching later messages when one full-message fetch fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    api.list.mockResolvedValue({ data: { messages: [{ id: "bad" }, { id: "good" }] } });
    api.get.mockRejectedValueOnce({ response: { status: 404 }, message: "sensitive request" });
    const result = await new GmailProviderClient(config).listUnreadMessages();
    expect(result.map((item) => item.providerMessageId)).toEqual(["good"]);
    expect(logged).toHaveBeenCalledWith("Mail operation failed (HTTP 404); it will be retried.");
    expect(api.modify).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("stops on revoked credentials without marking partially fetched messages read", async () => {
    api.list.mockResolvedValue({ data: { messages: [{ id: "first" }, { id: "second" }] } });
    api.get.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(new GmailProviderClient(config).listUnreadMessages()).rejects.toThrow("Reconnect the Gmail account");
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.modify).not.toHaveBeenCalled();
  });

  it.each([0, -1, 501, 1.5, Number.NaN])("rejects invalid page size %s", (maxResults) => {
    expect(() => new GmailProviderClient({ ...config, maxResults })).toThrow("page size");
  });
});
