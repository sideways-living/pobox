import { describe, expect, it } from "vitest";
import { MailPoller } from "../src/mail/poller.js";
import type { MailProviderClient, ProviderUnreadMessage } from "../src/mail/types.js";
import type { Session } from "../src/domain.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { AppStore, IncomingProviderMessage } from "../src/store/types.js";

class FakeProvider implements MailProviderClient {
  readonly providerName = "fake-mail";
  readonly markedRead: string[] = [];

  constructor(private readonly messages: ProviderUnreadMessage[]) {}

  async listUnreadMessages() {
    return this.messages;
  }

  async markMessageRead(providerMessageId: string) {
    this.markedRead.push(providerMessageId);
  }
}

function fakeStore(results: Array<"processed" | "duplicate" | "needs_review">) {
  const inputs: IncomingProviderMessage[] = [];
  return {
    inputs,
    store: {
      async processIncomingMail(input: IncomingProviderMessage) {
        inputs.push(input);
        return { kind: results.shift() ?? "needs_review" };
      }
    } as Pick<AppStore, "processIncomingMail">
  };
}

describe("mail poller", () => {
  const messages: ProviderUnreadMessage[] = [
    { providerMessageId: "gmail-1", sender: "alerts@example.com", subject: "Mail in box 1234", receivedAt: "2026-09-02T01:00:00.000Z" },
    { providerMessageId: "gmail-2", sender: "alerts@example.com", subject: "Mail in box 5678", receivedAt: "2026-09-02T02:00:00.000Z" },
    { providerMessageId: "gmail-3", sender: "alerts@example.com", subject: "Unknown box", receivedAt: "2026-09-02T03:00:00.000Z" }
  ];

  it("marks processed and duplicate provider messages read", async () => {
    const provider = new FakeProvider(messages);
    const { inputs, store } = fakeStore(["processed", "duplicate", "needs_review"]);
    const poller = new MailPoller({ provider, store }, { workspaceId: "ws_company", intervalMs: 30 * 60 * 1000 });

    const summary = await poller.pollOnce();

    expect(summary).toEqual({ scanned: 3, processed: 1, duplicates: 1, needsReview: 1, markedRead: 2 });
    expect(provider.markedRead).toEqual(["gmail-1", "gmail-2"]);
    expect(inputs.map((input) => input.workspaceId)).toEqual(["ws_company", "ws_company", "ws_company"]);
    expect(inputs.map((input) => input.provider)).toEqual(["fake-mail", "fake-mail", "fake-mail"]);
  });

  it("passes provider thread ids through to the store", async () => {
    const provider = new FakeProvider([
      { providerMessageId: "gmail-message-1", providerThreadId: "gmail-thread-1", sender: "alerts@example.com", subject: "Unknown box" }
    ]);
    const { inputs, store } = fakeStore(["needs_review"]);
    const poller = new MailPoller({ provider, store }, { workspaceId: "ws_company", intervalMs: 30 * 60 * 1000 });

    await poller.pollOnce();

    expect(inputs[0]).toMatchObject({
      providerMessageId: "gmail-message-1",
      providerThreadId: "gmail-thread-1"
    });
  });

  it("does not duplicate unresolved review items for the same message or thread", async () => {
    const store = await seededStore();
    const daniel = await loginSession(store);
    const provider = new FakeProvider([
      { providerMessageId: "gmail-review-1", providerThreadId: "gmail-thread-review", sender: "alerts@example.com", subject: "Unknown box" }
    ]);
    const poller = new MailPoller({ provider, store }, { workspaceId: "ws_company", intervalMs: 30 * 60 * 1000 });

    await expect(poller.pollOnce()).resolves.toMatchObject({ scanned: 1, needsReview: 1, markedRead: 0 });
    await expect(store.listReviewItems(daniel, "ws_company")).resolves.toHaveLength(1);
    await expect(poller.pollOnce()).resolves.toMatchObject({ scanned: 1, needsReview: 1, markedRead: 0 });
    await expect(store.listReviewItems(daniel, "ws_company")).resolves.toHaveLength(1);

    const sameThreadProvider = new FakeProvider([
      { providerMessageId: "gmail-review-2", providerThreadId: "gmail-thread-review", sender: "alerts@example.com", subject: "Unknown box follow-up" }
    ]);
    const sameThreadPoller = new MailPoller({ provider: sameThreadProvider, store }, { workspaceId: "ws_company", intervalMs: 30 * 60 * 1000 });

    await expect(sameThreadPoller.pollOnce()).resolves.toMatchObject({ scanned: 1, needsReview: 1, markedRead: 0 });
    await expect(store.listReviewItems(daniel, "ws_company")).resolves.toHaveLength(1);
  });

  it("marks reviewed and ignored unread messages read on the next poll", async () => {
    const store = await seededStore();
    const daniel = await loginSession(store);
    const resolvedProvider = new FakeProvider([
      { providerMessageId: "gmail-review-resolved", providerThreadId: "gmail-thread-resolved", sender: "alerts@example.com", subject: "Unknown box" }
    ]);
    const resolvedPoller = new MailPoller({ provider: resolvedProvider, store }, { workspaceId: "ws_company", intervalMs: 30 * 60 * 1000 });

    await expect(resolvedPoller.pollOnce()).resolves.toMatchObject({ scanned: 1, needsReview: 1, markedRead: 0 });
    const [resolvedItem] = await store.listReviewItems(daniel, "ws_company");
    await store.resolveReviewItem(daniel, "ws_company", resolvedItem.id, "box_1234");
    await expect(resolvedPoller.pollOnce()).resolves.toEqual({ scanned: 1, processed: 0, duplicates: 1, needsReview: 0, markedRead: 1 });
    expect(resolvedProvider.markedRead).toEqual(["gmail-review-resolved"]);

    const ignoredProvider = new FakeProvider([
      { providerMessageId: "gmail-review-ignored", providerThreadId: "gmail-thread-ignored", sender: "alerts@example.com", subject: "Unknown box" }
    ]);
    const ignoredPoller = new MailPoller({ provider: ignoredProvider, store }, { workspaceId: "ws_company", intervalMs: 30 * 60 * 1000 });

    await expect(ignoredPoller.pollOnce()).resolves.toMatchObject({ scanned: 1, needsReview: 1, markedRead: 0 });
    const [ignoredItem] = await store.listReviewItems(daniel, "ws_company");
    await store.dismissReviewItem(daniel, "ws_company", ignoredItem.id);
    await expect(ignoredPoller.pollOnce()).resolves.toEqual({ scanned: 1, processed: 0, duplicates: 1, needsReview: 0, markedRead: 1 });
    expect(ignoredProvider.markedRead).toEqual(["gmail-review-ignored"]);
  });
});

async function seededStore() {
  const store = new MemoryStore();
  await store.seedDemo();
  return store;
}

async function loginSession(store: MemoryStore): Promise<Session> {
  const result = await store.login("daniel@example.com", "Password123!");
  if (result.kind !== "session") throw new Error("Expected a session.");
  return result;
}
