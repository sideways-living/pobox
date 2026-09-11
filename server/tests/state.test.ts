import { beforeEach, describe, expect, it } from "vitest";
import { currentTotpCode } from "../src/auth/totp.js";
import type { Session } from "../src/domain.js";
import { appVersion } from "../src/releases.js";
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

  it("sets a separate parcel waiting flag for parcel pickup notices", async () => {
    const daniel = await loginSession("daniel@example.com");
    const office = await store.createPostOffice(daniel, "ws_company", {
      name: "FITZROY SOUTH",
      address: "Fitzroy South VIC",
      latitude: -37.801,
      longitude: 144.979,
      geofenceRadius: 200
    });
    const box = await store.createMailbox(daniel, "ws_company", { postOfficeId: office.id, boxNumber: "3020" });

    const result = await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "parcel-1",
      sender: "parcel@example.com",
      subject: "Your PO Box item is ready to collect",
      bodyPreview: "| Collect from: | **FITZROY SOUTH ** |",
      receivedAt: "2026-09-03T02:30:00.000Z"
    });

    expect(result).toEqual({ kind: "processed", mailboxId: box.id, notificationType: "PARCEL" });
    const snapshot = await store.dashboard(daniel, "ws_company");
    const updated = snapshot.postOffices.flatMap((item) => item.mailboxes).find((item) => item.id === box.id);
    expect(updated).toMatchObject({
      mailWaiting: false,
      parcelWaiting: true,
      latestParcelNotificationAt: "2026-09-03T02:30:00.000Z"
    });
    await expect(store.outstandingMailboxCount("ws_company")).resolves.toBe(1);

    await store.collectMailbox(daniel, "ws_company", box.id, "WEB");
    const collected = await store.dashboard(daniel, "ws_company");
    const cleared = collected.postOffices.flatMap((item) => item.mailboxes).find((item) => item.id === box.id);
    expect(cleared?.parcelWaiting).toBe(false);
  });

  it.each([false, true])("preserves both flags and timestamps with parcel first=%s", async (parcelFirst) => {
    const admin = await loginSession("daniel@example.com");
    const office = await store.createPostOffice(admin, "ws_company", { name: "Carlton North LPO", address: "Carlton North VIC", latitude: -37.78, longitude: 144.97, geofenceRadius: 100 });
    const box = await store.createMailbox(admin, "ws_company", { postOfficeId: office.id, boxNumber: "3020" });
    const base = { workspaceId: "ws_company", provider: "gmail", sender: "notice@example.test" };
    const mail = { ...base, providerMessageId: "letter", subject: "Mail2Day: PO Box 3020 has mail.", receivedAt: "2026-09-12T01:00:00.000Z" };
    const parcel = { ...base, providerMessageId: "parcel", subject: "Your PO Box item is ready to collect!", bodyPreview: "<table><tr><td>Collect from:</td><td>CARLTON NORTH</td></tr><tr><td>Address:</td><td>Example Street</td></tr></table>", receivedAt: "2026-09-12T02:00:00.000Z" };
    for (const message of parcelFirst ? [parcel, mail] : [mail, parcel]) {
      expect((await store.processIncomingMail(message)).kind).toBe("processed");
    }
    await store.processIncomingMail({ ...mail, providerMessageId: "letter-next-day", receivedAt: "2026-09-13T01:00:00.000Z" });
    const snapshot = await store.dashboard(admin, "ws_company");
    expect(snapshot.postOffices.flatMap((item) => item.mailboxes).find((item) => item.id === box.id)).toMatchObject({ mailWaiting: true, parcelWaiting: true, latestNotificationAt: "2026-09-13T01:00:00.000Z", latestParcelNotificationAt: parcel.receivedAt });
    expect([...store.mailEvents.values()].filter((event) => event.mailboxId === box.id)).toHaveLength(3);
    expect(await store.outstandingMailboxCount("ws_company")).toBe(1);
    expect(await store.listReviewItems(admin, "ws_company")).toHaveLength(0);
  });

  it("keeps ambiguous parcels in review and preserves their type on manual matching", async () => {
    const admin = await loginSession("daniel@example.com");
    const result = await store.processIncomingMail({ workspaceId: "ws_company", provider: "gmail", providerMessageId: "ambiguous-parcel", sender: "notice@example.test", subject: "Your PO Box item is ready to collect.", bodyPreview: "Collect from: SOUTH MELBOURNE" });
    expect(result.kind).toBe("needs_review");
    expect(await store.pendingMailAcknowledgements("ws_company", "gmail")).toEqual([]);
    const [review] = await store.listReviewItems(admin, "ws_company");
    expect(review.notificationType).toBe("PARCEL");
    await store.resolveReviewItem(admin, "ws_company", review.id, "box_882");
    expect(store.mailboxes.get("box_882")).toMatchObject({ mailWaiting: false, parcelWaiting: true });
    expect(await store.pendingMailAcknowledgements("ws_company", "gmail")).toEqual(["ambiguous-parcel"]);
  });

  it("processes exact Mail2Day subjects without review and flags mail waiting", async () => {
    const daniel = await loginSession("daniel@example.com");
    const office = await store.createPostOffice(daniel, "ws_company", {
      name: "SOUTH MELBOURNE POST OFFICE",
      address: "South Melbourne VIC",
      latitude: -37.832,
      longitude: 144.957,
      geofenceRadius: 200
    });
    const box = await store.createMailbox(daniel, "ws_company", { postOfficeId: office.id, boxNumber: "3020" });

    const result = await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "mail2day-3020",
      sender: "mail2day@example.com",
      subject: "Mail2Day: PO Box 3020 has mail",
      receivedAt: "2026-09-06T03:15:00.000Z"
    });

    expect(result).toEqual({ kind: "processed", mailboxId: box.id, notificationType: "MAIL" });
    await expect(store.listReviewItems(daniel, "ws_company")).resolves.toHaveLength(0);
    const snapshot = await store.dashboard(daniel, "ws_company");
    const updated = snapshot.postOffices.flatMap((item) => item.mailboxes).find((item) => item.id === box.id);
    expect(updated).toMatchObject({
      mailWaiting: true,
      parcelWaiting: false,
      latestNotificationAt: "2026-09-06T03:15:00.000Z"
    });
  });

  it("processes parcel collect-from notices without review and flags parcel waiting", async () => {
    const daniel = await loginSession("daniel@example.com");
    await store.deleteMailbox(daniel, "ws_company", "box_5678");

    const result = await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "parcel-south-melbourne",
      sender: "parcel@example.com",
      subject: "Your PO Box item is ready to collect",
      bodyPreview: "Collect from: SOUTH MELBOURNE",
      receivedAt: "2026-09-06T04:45:00.000Z"
    });

    expect(result).toEqual({ kind: "processed", mailboxId: "box_882", notificationType: "PARCEL" });
    await expect(store.listReviewItems(daniel, "ws_company")).resolves.toHaveLength(0);
    const snapshot = await store.dashboard(daniel, "ws_company");
    const updated = snapshot.postOffices.flatMap((item) => item.mailboxes).find((item) => item.id === "box_882");
    expect(updated).toMatchObject({
      mailWaiting: false,
      parcelWaiting: true,
      latestParcelNotificationAt: "2026-09-06T04:45:00.000Z"
    });
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
      confidence: 0.55,
      reason: "PO Box UNKNOWN is not saved yet."
    });
  });

  it("lets admins resolve and dismiss review items", async () => {
    const daniel = await loginSession("daniel@example.com");
    await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-review-resolve",
      sender: "mailroom@example.com",
      subject: "Mail waiting somewhere",
      bodyPreview: "Please check the unknown box.",
      receivedAt: "2026-09-03T01:23:00.000Z"
    });

    const [reviewItem] = await store.listReviewItems(daniel, "ws_company");
    expect(reviewItem).toMatchObject({
      providerMessageId: "message-review-resolve",
      sender: "mailroom@example.com",
      bodyPreview: "Please check the unknown box."
    });
    expect(reviewItem.receivedAt).toBe("2026-09-03T01:23:00.000Z");

    const resolved = await store.resolveReviewItem(daniel, "ws_company", reviewItem.id, "box_1234");
    expect(resolved).toEqual({ kind: "processed", mailboxId: "box_1234", notificationType: "MAIL" });
    await expect(store.outstandingMailboxCount("ws_company")).resolves.toBe(1);
    await expect(store.listReviewItems(daniel, "ws_company")).resolves.toHaveLength(0);
    await expect(
      store.processIncomingMail({
        workspaceId: "ws_company",
        provider: "mock",
        providerMessageId: "message-review-resolve",
        sender: "mailroom@example.com",
        subject: "Mail waiting somewhere"
      })
    ).resolves.toEqual({ kind: "duplicate", mailboxId: "box_1234", notificationType: "MAIL" });

    await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-review-dismiss",
      sender: "mailroom@example.com",
      subject: "No useful box number"
    });
    const dismissItems = await store.listReviewItems(daniel, "ws_company");
    expect(dismissItems).toHaveLength(1);
    await store.dismissReviewItem(daniel, "ws_company", dismissItems[0].id);
    await expect(store.listReviewItems(daniel, "ws_company")).resolves.toHaveLength(0);
    await expect(
      store.processIncomingMail({
        workspaceId: "ws_company",
        provider: "mock",
        providerMessageId: "message-review-dismiss",
        sender: "mailroom@example.com",
        subject: "No useful box number"
      })
    ).resolves.toEqual({ kind: "duplicate", notificationType: "MAIL" });
  });

  it("lets admins mark review items resolved without changing a box", async () => {
    const daniel = await loginSession("daniel@example.com");
    await store.processIncomingMail({
      workspaceId: "ws_company",
      provider: "mock",
      providerMessageId: "message-review-noop",
      sender: "mailroom@example.com",
      subject: "Ignore this operational notice"
    });

    const [reviewItem] = await store.listReviewItems(daniel, "ws_company");
    expect(reviewItem.reason).toBe("No PO box number could be read from the email.");
    await store.markReviewItemResolved(daniel, "ws_company", reviewItem.id);
    await expect(store.listReviewItems(daniel, "ws_company")).resolves.toHaveLength(0);
    await expect(store.outstandingMailboxCount("ws_company")).resolves.toBe(0);
    await expect(
      store.processIncomingMail({
        workspaceId: "ws_company",
        provider: "mock",
        providerMessageId: "message-review-noop",
        sender: "mailroom@example.com",
        subject: "Ignore this operational notice"
      })
    ).resolves.toEqual({ kind: "duplicate", notificationType: "MAIL" });
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

  it("returns relevant release notes on first login", async () => {
    const daniel = await loginSession("daniel@example.com");

    const notice = await store.appChanges(daniel, "ws_company");

    expect(notice.version).toBe(appVersion);
    expect(notice.lastSeenVersion).toBeUndefined();
    expect(notice.changes.length).toBeGreaterThan(1);
    expect(notice.changes[0].version).toBe(appVersion);
  });

  it("does not return release notes again after the user dismisses them", async () => {
    const daniel = await loginSession("daniel@example.com");
    const notice = await store.appChanges(daniel, "ws_company");

    const afterDismissal = await store.markAppChangesSeen(daniel, "ws_company", notice.version);
    const repeatLogin = await loginSession("daniel@example.com");
    const repeatNotice = await store.appChanges(repeatLogin, "ws_company");

    expect(afterDismissal.lastSeenVersion).toBe(appVersion);
    expect(afterDismissal.changes).toHaveLength(0);
    expect(repeatNotice.lastSeenVersion).toBe(appVersion);
    expect(repeatNotice.changes).toHaveLength(0);
  });

  it("returns multiple release notes after the last seen version", async () => {
    const daniel = await loginSession("daniel@example.com");

    const notice = await store.markAppChangesSeen(daniel, "ws_company", "0.12.3");
    const versions = notice.changes.map((change) => change.version);

    expect(notice.lastSeenVersion).toBe("0.12.3");
    expect(versions).toContain("0.12.4");
    expect(versions).toContain("0.12.5");
    expect(versions).toContain("0.12.6");
    expect(versions).not.toContain("0.12.3");
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
    await expect(store.updateUser(sarah, "ws_company", "usr_daniel", { displayName: "Changed" })).rejects.toThrow("Admin role required.");
    await expect(store.deleteUser(sarah, "ws_company", "usr_daniel")).rejects.toThrow("Admin role required.");
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
      phone: "+61 3 9000 0000",
      latitude: -37.8001,
      longitude: 144.9671,
      geofenceRadius: 180
    });
    expect(office.phone).toBe("+61 3 9000 0000");
    const mailbox = await store.createMailbox(daniel, "ws_company", {
      postOfficeId: office.id,
      boxNumber: "9001"
    });
    expect(mailbox.name).toBe("PO Box 9001");
    const secondMailbox = await store.createMailbox(daniel, "ws_company", {
      postOfficeId: office.id,
      boxNumber: "9002"
    });
    expect(secondMailbox.postOfficeId).toBe(office.id);

    const snapshot = await store.dashboard(daniel, "ws_company");
    expect(snapshot.postOffices.some((candidate) => candidate.id === office.id)).toBe(true);
    expect(snapshot.postOffices.flatMap((candidate) => candidate.mailboxes).some((candidate) => candidate.id === mailbox.id)).toBe(true);
    expect(snapshot.postOffices.flatMap((candidate) => candidate.mailboxes).some((candidate) => candidate.id === secondMailbox.id)).toBe(true);
  });

  it("allows the same PO box number at different post offices but not the same post office", async () => {
    const daniel = await loginSession("daniel@example.com");
    const firstOffice = await store.createPostOffice(daniel, "ws_company", {
      name: "Carlton Post Office",
      address: "123 Lygon Street, Carlton VIC",
      latitude: -37.8001,
      longitude: 144.9671,
      geofenceRadius: 180
    });
    const secondOffice = await store.createPostOffice(daniel, "ws_company", {
      name: "Richmond Post Office",
      address: "456 Swan Street, Richmond VIC",
      latitude: -37.825,
      longitude: 144.997,
      geofenceRadius: 200
    });

    const firstBox = await store.createMailbox(daniel, "ws_company", { postOfficeId: firstOffice.id, boxNumber: "229" });
    const secondBox = await store.createMailbox(daniel, "ws_company", { postOfficeId: secondOffice.id, boxNumber: "229" });

    expect(firstBox.postOfficeId).toBe(firstOffice.id);
    expect(secondBox.postOfficeId).toBe(secondOffice.id);
    await expect(store.createMailbox(daniel, "ws_company", { postOfficeId: firstOffice.id, boxNumber: "PO Box 229" })).rejects.toThrow(
      "This post office already has that PO box number."
    );
    await expect(store.updateMailbox(daniel, "ws_company", secondBox.id, { postOfficeId: firstOffice.id, boxNumber: "229" })).rejects.toThrow(
      "This post office already has that PO box number."
    );
  });

  it("allows admins to edit and delete managed records", async () => {
    const daniel = await loginSession("daniel@example.com");
    const office = await store.createPostOffice(daniel, "ws_company", {
      name: "Carlton Post Office",
      address: "123 Lygon Street, Carlton VIC",
      phone: "+61 3 9000 0000",
      latitude: -37.8001,
      longitude: 144.9671,
      geofenceRadius: 180
    });
    const mailbox = await store.createMailbox(daniel, "ws_company", {
      postOfficeId: office.id,
      boxNumber: "9001"
    });
    const user = await store.createUser(daniel, "ws_company", {
      email: "ops-delete@example.com",
      displayName: "Ops Delete",
      password: "Temporary123!",
      role: "MEMBER"
    });

    const updatedOffice = await store.updatePostOffice(daniel, "ws_company", office.id, { name: "Carlton North Post Office" });
    expect(updatedOffice.name).toBe("Carlton North Post Office");

    const updatedMailbox = await store.updateMailbox(daniel, "ws_company", mailbox.id, { boxNumber: "9002" });
    expect(updatedMailbox.name).toBe("PO Box 9002");

    const updatedUser = await store.updateUser(daniel, "ws_company", user.id, { displayName: "Ops Updated", role: "ADMIN" });
    expect(updatedUser.displayName).toBe("Ops Updated");
    expect(updatedUser.role).toBe("ADMIN");

    const disabledUser = await store.updateUser(daniel, "ws_company", user.id, { status: "DISABLED" });
    expect(disabledUser.status).toBe("DISABLED");
    expect(disabledUser.active).toBe(false);
    await expect(store.login("ops-delete@example.com", "Temporary123!")).rejects.toThrow("Invalid email or password.");

    const reactivatedUser = await store.updateUser(daniel, "ws_company", user.id, { status: "ACTIVE" });
    expect(reactivatedUser.status).toBe("ACTIVE");
    expect(reactivatedUser.active).toBe(true);

    await store.deleteMailbox(daniel, "ws_company", mailbox.id);
    await store.deletePostOffice(daniel, "ws_company", office.id);
    await store.deleteUser(daniel, "ws_company", user.id);

    const snapshot = await store.dashboard(daniel, "ws_company");
    expect(snapshot.postOffices.some((candidate) => candidate.id === office.id)).toBe(false);
    expect(snapshot.postOffices.flatMap((candidate) => candidate.mailboxes).some((candidate) => candidate.id === mailbox.id)).toBe(false);
    const members = await store.listMembers(daniel, "ws_company");
    expect(members.find((candidate) => candidate.id === user.id)?.active).toBe(false);
    expect(members.find((candidate) => candidate.id === user.id)?.status).toBe("DISABLED");
    expect([...store.auditEvents.values()].some((event) => event.eventType === "member.deleted" && event.entityId === user.id)).toBe(true);
  });

  it("does not allow admins to delete themselves", async () => {
    const daniel = await loginSession("daniel@example.com");
    await expect(store.deleteUser(daniel, "ws_company", daniel.userId)).rejects.toThrow("You cannot delete your own user.");
    await expect(store.updateUser(daniel, "ws_company", daniel.userId, { status: "DISABLED" })).rejects.toThrow("You cannot change your own access status.");
    await expect(store.updateUser(daniel, "ws_company", daniel.userId, { role: "MEMBER" })).rejects.toThrow("You cannot change your own role.");
  });

  it("keeps at least one active admin", async () => {
    const daniel = await loginSession("daniel@example.com");
    await store.updateUser(daniel, "ws_company", "usr_sarah", { status: "DISABLED" });

    await expect(store.updateUser(daniel, "ws_company", daniel.userId, { status: "DISABLED" })).rejects.toThrow("You cannot change your own access status.");
    await expect(store.deleteUser(daniel, "ws_company", "usr_daniel")).rejects.toThrow("You cannot delete your own user.");

    const ops = await store.createUser(daniel, "ws_company", {
      email: "second-admin@example.com",
      displayName: "Second Admin",
      password: "Temporary123!",
      role: "ADMIN"
    });
    await store.updateUser(daniel, "ws_company", "usr_sarah", { role: "MEMBER", status: "ACTIVE" });
    await store.deleteUser(daniel, "ws_company", ops.id);

    const remainingAdmins = (await store.listMembers(daniel, "ws_company")).filter((member) => member.role === "ADMIN" && member.status === "ACTIVE" && member.active);
    expect(remainingAdmins.map((member) => member.id)).toEqual(["usr_daniel"]);
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
