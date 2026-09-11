import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memoryStore.js";
import { buildServer } from "../src/api/server.js";
import { realtimeHub } from "../src/realtime/hub.js";
import type { FastifyInstance } from "fastify";
import type { Session } from "../src/domain.js";

describe("workspace permissions and live updates", () => {
  let store: MemoryStore;
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  beforeEach(async () => {
    store = new MemoryStore(); app = await buildServer(store);
    admin = await store.createSessionForUser("usr_daniel");
    const user = await store.createUser(admin, "ws_company", { email: "member@example.test", displayName: "Member", password: "Temporary123!", role: "MEMBER" });
    member = await store.createSessionForUser(user.id);
    for (const session of [admin, member]) {
      store.users.get(session.userId)!.totpEnabled = true;
      store.passkeyCredentials.set(session.userId, { id: session.userId, userId: session.userId, credentialId: session.userId, publicKey: Buffer.from("fixture"), counter: 0, transports: [], friendlyName: "Fixture" });
    }
    store.workspaces.set("other", { id: "other", name: "Private workspace" });
  });
  afterEach(async () => { await app.close(); });
  const request = (session: Session, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: object) => app.inject({ method, url: `/api/v1/workspaces/${path}`, headers: { cookie: `pobox_watch_session=${session.id}` }, payload });

  it("permits MapKit WASM and CDN without enabling arbitrary script evaluation", async () => {
    const response = await request(admin, "GET", "ws_company/dashboard");
    const policy = String(response.headers["content-security-policy"]);
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).toContain("https://cdn.apple-mapkit.com");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it("only acknowledges an explicit known displayed version, including an older tab", async () => {
    expect((await request(admin, "POST", "ws_company/app/changes/seen", {})).statusCode).toBe(400);
    expect((await request(admin, "POST", "ws_company/app/changes/seen", { version: "99.0.0" })).statusCode).toBe(400);
    const response = await request(admin, "POST", "ws_company/app/changes/seen", { version: "0.12.3" });
    expect(response.statusCode).toBe(200);
    expect(response.json().changes.length).toBeGreaterThan(0);
    expect((await request(member, "GET", "ws_company/app/changes")).json().lastSeenVersion).toBeUndefined();
  });

  it("denies foreign workspace reads and writes across the workspace route surface", async () => {
    for (const path of ["dashboard", "team/members", "review-items", "app/changes", "post-office-locations/status", "post-office-locations/search?query=south"]) {
      expect((await request(admin, "GET", `other/${path}`)).statusCode, path).toBe(403);
    }
    for (const [path, payload] of [["mailboxes", { postOfficeId: "po_melbourne_gpo", boxNumber: "99" }], ["review-items/missing/resolve", { mailboxId: "box_1234" }], ["post-office-locations/sync", {}], ["team/invitations", { email: "other@example.test", role: "MEMBER" }]] as const) {
      expect((await request(admin, "POST", `other/${path}`, payload)).statusCode).toBe(403);
    }
  });

  it("rejects member administration and cross-workspace resource IDs", async () => {
    expect((await request(member, "POST", "ws_company/mailboxes", { postOfficeId: "po_melbourne_gpo", boxNumber: "99" })).statusCode).toBe(403);
    expect((await request(member, "DELETE", `ws_company/team/users/${admin.userId}`)).statusCode).toBe(403);
    expect((await request(member, "POST", "ws_company/post-office-locations/sync", {})).statusCode).toBe(403);
    store.postOffices.set("foreign", { ...store.postOffices.get("po_melbourne_gpo")!, id: "foreign", workspaceId: "other" });
    expect((await request(admin, "POST", "ws_company/mailboxes", { postOfficeId: "foreign", boxNumber: "1" })).statusCode).toBe(404);
    expect((await request(admin, "DELETE", "ws_company/post-offices/foreign")).statusCode).toBe(404);
  });

  it("disables only this workspace and keeps attribution and other workspace access", async () => {
    store.members.set("shared", { id: "shared", userId: member.userId, workspaceId: "other", role: "MEMBER", status: "ACTIVE" });
    await store.processIncomingMail({ workspaceId: "ws_company", provider: "gmail", providerMessageId: "mail", sender: "notice@example.test", subject: "Mail2Day: PO Box 1234 has mail" });
    const event = await store.collectMailbox(member, "ws_company", "box_1234", "WEB");
    await store.deleteUser(admin, "ws_company", member.userId);
    expect((await request(member, "GET", "ws_company/dashboard")).statusCode).toBe(403);
    expect((await request(member, "GET", "other/dashboard")).statusCode).toBe(200);
    expect(store.collectionEvents.get(event.id)?.collectedBy).toBe(member.userId);
    expect(store.users.has(member.userId)).toBe(true);
    await expect(store.updateUser(admin, "ws_company", member.userId, { email: "stolen@example.test" })).rejects.toThrow("Shared account");
  });

  it("requires edit preconditions and rejects stale forms", async () => {
    const office = store.postOffices.get("po_melbourne_gpo")!;
    expect((await request(admin, "PATCH", `ws_company/post-offices/${office.id}`, { name: "Overwrite" })).statusCode).toBe(400);
    const input = { expectedUpdatedAt: office.updatedAt, name: "First edit" };
    expect((await request(admin, "PATCH", `ws_company/post-offices/${office.id}`, input)).statusCode).toBe(200);
    expect((await request(admin, "PATCH", `ws_company/post-offices/${office.id}`, { ...input, name: "Stale edit" })).statusCode).toBe(409);
    expect(store.postOffices.get(office.id)?.name).toBe("First edit");
  });

  it("does not let an old team form undo a newer access decision", async () => {
    const target = (await store.listMembers(admin, "ws_company")).find(item => item.id === member.userId)!;
    const path = `ws_company/team/users/${member.userId}`;
    expect((await request(admin, "PATCH", path, { expectedVersion: target.version, status: "DISABLED" })).statusCode).toBe(200);
    expect((await request(admin, "PATCH", path, { expectedVersion: target.version, status: "ACTIVE", role: "ADMIN" })).statusCode).toBe(409);
    expect((await store.listMembers(admin, "ws_company")).find(item => item.id === member.userId)?.status).toBe("DISABLED");
  });

  it("broadcasts invalidation only and closes disabled subscribers before sending data", async () => {
    await app.ready();
    const ws = await app.injectWS("/api/v1/workspaces/ws_company/realtime", { headers: { cookie: `pobox_watch_session=${member.id}` } });
    const messages: string[] = [];
    ws.on("message", raw => messages.push(raw.toString()));
    await new Promise(resolve => setTimeout(resolve, 20));
    realtimeHub.emitWorkspace("other", { secret: "foreign" });
    realtimeHub.emitWorkspace("ws_company", { type: "dashboard.updated", snapshot: { currentUser: { email: "private-admin" } } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(messages.some(raw => raw.includes("workspace.changed"))).toBe(true);
    expect(messages.join()).not.toMatch(/private-admin|foreign|snapshot/);
    await store.deleteUser(admin, "ws_company", member.userId);
    const closed = new Promise<number>(resolve => ws.once("close", resolve));
    realtimeHub.emitWorkspace("ws_company", {});
    expect(await closed).toBe(1008);
  });
});
