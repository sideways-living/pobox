import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { FastifyInstance } from "fastify";

describe("review API workflow", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let cookie: string;
  const base = "/api/v1/workspaces/ws_company/review-items";
  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildServer(store);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "daniel@example.com", password: "Password123!" } });
    cookie = `pobox_watch_session=${login.cookies[0].value}`;
    store.users.get("usr_daniel")!.totpEnabled = true;
    store.passkeyCredentials.set("fixture", { id: "fixture", userId: "usr_daniel", credentialId: "fixture", publicKey: Buffer.from("fixture"), counter: 0, transports: [], friendlyName: "Fixture" });
    await store.processIncomingMail({ workspaceId: "ws_company", provider: "gmail", providerMessageId: "missing", sender: "sender@example.test", subject: "Mail2Day: PO Box 3020 has mail", receivedAt: "2026-09-12T01:23:00Z", bodyPreview: "<p>Mail is waiting.</p><script>alert('bad')</script>" });
  });
  afterEach(async () => { await app.close(); });
  const request = (url: string, payload?: Record<string, unknown>) => app.inject({ method: payload ? "POST" : "GET", url, headers: { cookie }, payload });

  it("shows complete readable details, creates and resolves in one request, and retries safely", async () => {
    const response = await request(base);
    expect(response.statusCode).toBe(200);
    const [review] = response.json();
    expect(review).toMatchObject({ sender: "sender@example.test", receivedAt: "2026-09-12T01:23:00Z", mailboxNumber: "3020", bodyPreview: "Mail is waiting.", reason: "PO Box 3020 is not saved yet." });
    const office = [...store.postOffices.values()][0];
    const payload = { newMailbox: { postOfficeId: office.id, boxNumber: "3020" } };
    expect((await request(`${base}/${review.id}/resolve`, payload)).statusCode).toBe(200);
    expect((await request(`${base}/${review.id}/resolve`, payload)).statusCode).toBe(200);
    expect([...store.mailboxes.values()].filter((box) => box.boxNumber === "3020")).toHaveLength(1);
    expect((await request(base)).json()).toEqual([]);
    expect(await store.pendingMailAcknowledgements("ws_company", "gmail")).toEqual(["missing"]);
    expect([...store.auditEvents.values()].some((event) => event.id === review.id)).toBe(true);
  });

  it("rejects malformed choices and unavailable offices without creating boxes", async () => {
    const [review] = (await request(base)).json();
    expect((await request(`${base}/${review.id}/resolve`, { mailboxId: "box_1234", newMailbox: { postOfficeId: "bad", boxNumber: "3020" } })).statusCode).toBe(400);
    expect((await request(`${base}/${review.id}/resolve`, { newMailbox: { postOfficeId: "bad", boxNumber: "3020" } })).statusCode).toBe(404);
    expect((await request(base)).json()).toHaveLength(1);
  });

  it("matches existing boxes, prevents conflicting later decisions, and rejects non-admin writes", async () => {
    const [review] = (await request(base)).json();
    const membership = [...store.members.values()].find((member) => member.userId === "usr_daniel")!;
    membership.role = "MEMBER";
    expect((await request(`${base}/${review.id}/resolve`, { mailboxId: "box_1234" })).statusCode).toBe(403);
    membership.role = "ADMIN";
    expect((await request(`${base}/${review.id}/resolve`, { mailboxId: "box_1234" })).statusCode).toBe(200);
    expect((await request(`${base}/${review.id}/dismiss`, {})).statusCode).toBe(409);
  });
});
