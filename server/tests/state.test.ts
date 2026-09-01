import { beforeEach, describe, expect, it } from "vitest";
import { currentTotpCode } from "../src/auth/totp.js";
import type { Session } from "../src/domain.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { ConflictError } from "../src/store/types.js";

describe("shared mailbox state", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.seedDemo();
  });

  async function loginSession(email: string): Promise<Session> {
    const result = await store.login(email, "Password123!");
    if (result.kind !== "session") throw new Error("Expected a session.");
    return result;
  }

  it("deduplicates provider messages, not mailbox days", async () => {
    const daniel = await loginSession("daniel@example.com");
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
    const john = await loginSession("john@example.com");
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

  it("lists parser exceptions that need review", async () => {
    const john = await loginSession("john@example.com");
    const result = await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-review-1",
      sender: "mailroom@example.com",
      subject: "There is mail in PO Box UNKNOWN"
    });
    expect(result.kind).toBe("needs_review");

    const reviewItems = await store.listReviewItems(john, "ws_company");
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0]).toMatchObject({
      providerMessageId: "message-review-1",
      subject: "There is mail in PO Box UNKNOWN",
      mailboxNumber: "UNKNOWN",
      confidence: 0.55
    });
  });

  it("returns the previous login time on later logins", async () => {
    const first = await loginSession("john@example.com");
    expect(first.previousLoginAt).toBeUndefined();

    const second = await loginSession("john@example.com");
    expect(second.previousLoginAt).toBeDefined();
    expect(new Date(second.previousLoginAt ?? "").getTime()).toBeGreaterThan(0);
  });

  it("requires a second factor after TOTP is enabled", async () => {
    const john = await loginSession("john@example.com");
    const setup = await store.beginTotpSetup(john);
    const recovery = await store.confirmTotpSetup(john, currentTotpCode(setup.secret));
    expect(recovery.recoveryCodes).toHaveLength(10);

    const challenged = await store.login("john@example.com", "Password123!");
    expect(challenged.kind).toBe("two_factor_required");
    if (challenged.kind !== "two_factor_required") throw new Error("Expected two-factor challenge.");

    await expect(store.getSession(challenged.challengeId)).rejects.toThrow("Session expired.");
    const session = await store.verifySecondFactor(challenged.challengeId, currentTotpCode(setup.secret));
    expect(session.userId).toBe("usr_john");
  });

  it("allows a recovery code to complete one login once", async () => {
    const john = await loginSession("john@example.com");
    const setup = await store.beginTotpSetup(john);
    const recovery = await store.confirmTotpSetup(john, currentTotpCode(setup.secret));

    const challenged = await store.login("john@example.com", "Password123!");
    if (challenged.kind !== "two_factor_required") throw new Error("Expected two-factor challenge.");
    const session = await store.verifySecondFactor(challenged.challengeId, recovery.recoveryCodes[0]);
    expect(session.userId).toBe("usr_john");

    const secondChallenge = await store.login("john@example.com", "Password123!");
    if (secondChallenge.kind !== "two_factor_required") throw new Error("Expected two-factor challenge.");
    await expect(store.verifySecondFactor(secondChallenge.challengeId, recovery.recoveryCodes[0])).rejects.toThrow("Invalid two-factor code.");
  });

  it("generates passkey registration and authentication options", async () => {
    const john = await loginSession("john@example.com");
    const registration = await store.beginPasskeyRegistration(john);
    expect(registration.options.rp.id).toBe("localhost");
    expect(registration.options.user.name).toBe("john@example.com");
    expect(registration.options.challenge).toBeTruthy();

    const authentication = await store.beginPasskeyAuthentication("john@example.com");
    expect(authentication.options.rpId).toBe("localhost");
    expect(authentication.options.challenge).toBeTruthy();

    const status = await store.securityStatus(john);
    expect(status.passkeysAvailable).toBe(true);
    expect(status.passkeyCount).toBe(0);
  });

  it("rejects member-only admin operations", async () => {
    const sarah = await loginSession("sarah@example.com");
    await expect(store.inviteMember(sarah, "ws_company", "alex@example.com", "MEMBER")).rejects.toThrow("Admin role required.");
    await expect(
      store.createUser(sarah, "ws_company", {
        email: "ops@example.com",
        displayName: "Ops",
        password: "Temporary123!",
        role: "MEMBER"
      })
    ).rejects.toThrow("Admin role required.");
  });

  it("allows admins to create users, post offices, and mailboxes", async () => {
    const daniel = await loginSession("daniel@example.com");
    const user = await store.createUser(daniel, "ws_company", {
      email: "ops@example.com",
      displayName: "Ops Lead",
      password: "Temporary123!",
      role: "MEMBER"
    });
    expect(user.email).toBe("ops@example.com");

    const office = await store.createPostOffice(daniel, "ws_company", {
      name: "Carlton Post Office",
      address: "123 Lygon Street, Carlton VIC",
      latitude: -37.8001,
      longitude: 144.9671,
      geofenceRadius: 180
    });
    const mailbox = await store.createMailbox(daniel, "ws_company", {
      postOfficeId: office.id,
      name: "PO Box 9001",
      boxNumber: "9001"
    });

    const snapshot = await store.dashboard(daniel, "ws_company");
    expect(snapshot.postOffices.some((candidate) => candidate.id === office.id)).toBe(true);
    expect(snapshot.postOffices.flatMap((candidate) => candidate.mailboxes).some((candidate) => candidate.id === mailbox.id)).toBe(true);
  });

  it("makes simultaneous collection idempotent", async () => {
    const sarah = await loginSession("sarah@example.com");
    const daniel = await loginSession("daniel@example.com");
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
