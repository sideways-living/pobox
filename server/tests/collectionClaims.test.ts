import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectionClaimExpiresAt } from "../src/collectionClaims.js";
import type { Session } from "../src/domain.js";
import { MemoryStore } from "../src/store/memoryStore.js";

describe("post office collection claims", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.seedDemo();
  });

  afterEach(() => vi.useRealTimers());

  async function session(email: string): Promise<Session> {
    const result = await store.login(email, "Password123!");
    if (result.kind !== "session") throw new Error("Expected a session.");
    return result;
  }

  async function addWaitingMail() {
    await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "gmail",
      providerMessageId: "claim-test-mail",
      sender: "mail2day@example.test",
      subject: "Mail2Day: PO Box 1234 has mail"
    });
  }

  it("shows the collector to everyone and blocks competing collection", async () => {
    const daniel = await session("daniel@example.com");
    const sarah = await session("sarah@example.com");
    await addWaitingMail();

    const claim = await store.claimPostOffice(daniel, "ws_company", "po_melbourne_gpo");
    expect(claim).toMatchObject({ userId: "usr_daniel", displayName: "Daniel" });
    expect((await store.dashboard(sarah, "ws_company")).postOffices.find((office) => office.id === "po_melbourne_gpo")?.collectionClaim).toMatchObject({ userId: "usr_daniel" });
    await expect(store.claimPostOffice(sarah, "ws_company", "po_melbourne_gpo")).rejects.toThrow("Daniel is already collecting");
    await expect(store.collectMailbox(sarah, "ws_company", "box_1234", "IPHONE")).rejects.toThrow("Daniel is collecting");

    await store.collectMailbox(daniel, "ws_company", "box_1234", "WEB");
    expect((await store.dashboard(daniel, "ws_company")).postOffices.find((office) => office.id === "po_melbourne_gpo")?.collectionClaim).toBeUndefined();
  });

  it("allows the collector to cancel and another user to take over", async () => {
    const daniel = await session("daniel@example.com");
    const sarah = await session("sarah@example.com");
    await addWaitingMail();
    await store.claimPostOffice(daniel, "ws_company", "po_melbourne_gpo");
    await store.releasePostOfficeClaim(daniel, "ws_company", "po_melbourne_gpo");
    await expect(store.claimPostOffice(sarah, "ws_company", "po_melbourne_gpo")).resolves.toMatchObject({ userId: "usr_sarah" });
  });

  it("automatically expires a claim at 3am and allows another collector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T15:00:00.000Z")); // 2am in Melbourne.
    const daniel = await session("daniel@example.com");
    const sarah = await session("sarah@example.com");
    await addWaitingMail();
    expect((await store.claimPostOffice(daniel, "ws_company", "po_melbourne_gpo")).expiresAt).toBe("2026-01-16T16:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-16T16:01:00.000Z"));
    await expect(store.claimPostOffice(sarah, "ws_company", "po_melbourne_gpo")).resolves.toMatchObject({ userId: "usr_sarah" });
  });
});

describe("collection claim expiry", () => {
  it("uses the next Melbourne 3am across daylight-saving and standard time", () => {
    expect(collectionClaimExpiresAt(new Date("2026-01-15T15:00:00.000Z"), "Australia/Melbourne").toISOString()).toBe("2026-01-16T16:00:00.000Z");
    expect(collectionClaimExpiresAt(new Date("2026-01-15T17:00:00.000Z"), "Australia/Melbourne").toISOString()).toBe("2026-01-16T16:00:00.000Z");
    expect(collectionClaimExpiresAt(new Date("2026-07-15T16:30:00.000Z"), "Australia/Melbourne").toISOString()).toBe("2026-07-16T17:00:00.000Z");
  });
});
