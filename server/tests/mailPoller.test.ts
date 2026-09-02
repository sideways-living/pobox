import { describe, expect, it } from "vitest";
import { MailPoller } from "../src/mail/poller.js";
import type { MailProviderClient, ProviderUnreadMessage } from "../src/mail/types.js";
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
});
