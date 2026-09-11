import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/api/server.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { currentTotpCode } from "../src/auth/totp.js";
import type { FastifyInstance } from "fastify";
import type { Session } from "../src/domain.js";

describe("mandatory security and recovery", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let session: Session;
  let secret: string;
  let recovery: string[];
  const cookie = (value: Session) => `pobox_watch_session=${value.id}`;
  const dashboard = (value: Session) => app.inject({ method: "GET", url: "/api/v1/workspaces/ws_company/dashboard", headers: { cookie: cookie(value) } });
  beforeEach(async () => {
    store = new MemoryStore(); app = await buildServer(store);
    const login = await store.login("daniel@example.com", "Password123!");
    if (login.kind !== "session") throw new Error("Expected onboarding");
    session = login;
    secret = (await store.beginTotpSetup(session)).secret;
    recovery = (await store.confirmTotpSetup(session, currentTotpCode(secret))).recoveryCodes;
    session = await store.getSession(session.id);
    store.passkeyCredentials.set("fixture", { id: "fixture", userId: session.userId, credentialId: "fixture", publicKey: Buffer.from("fixture"), counter: 0, transports: [], friendlyName: "Fixture" });
  });
  afterEach(async () => { await app.close(); });

  it("requires the session itself to prove 2FA, not just the account to be configured", async () => {
    expect((await dashboard(session)).statusCode).toBe(200);
    const stale = { ...session, id: "unverified-session", secondFactorVerified: false };
    store.sessions.set(stale.id, stale);
    expect((await dashboard(stale)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/passkeys/registration-options", headers: { cookie: cookie(stale) } })).statusCode).toBe(401);
    store.passkeyCredentials.clear();
    expect((await dashboard(session)).statusCode).toBe(403);
  });

  it("revokes the server session on logout, including copied cookies", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: cookie(session) } })).statusCode).toBe(200);
    expect((await dashboard(session)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout" })).statusCode).toBe(200);
  });

  it("rejects expired sessions and disabled accounts", async () => {
    store.sessions.set(session.id, { ...session, expiresAt: new Date(0).toISOString() });
    expect((await dashboard(session)).statusCode).toBe(401);
    store.sessions.set(session.id, session);
    store.users.get(session.userId)!.active = false;
    expect((await dashboard(session)).statusCode).toBe(401);
  });

  it("consumes a recovery code once even with separate login challenges", async () => {
    const one = await store.login("daniel@example.com", "Password123!");
    const two = await store.login("daniel@example.com", "Password123!");
    if (one.kind !== "two_factor_required" || two.kind !== "two_factor_required") throw new Error("Expected 2FA");
    const results = await Promise.allSettled([store.verifySecondFactor(one.challengeId, recovery[0]), store.verifySecondFactor(two.challengeId, recovery[0])]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    await expect(store.verifySecondFactor(one.challengeId, recovery[1])).rejects.toThrow();
    const renewed = await store.verifySecondFactor(two.challengeId, recovery[1]);
    expect(renewed.secondFactorVerified).toBe(true);
  });

  it("replaces an authenticator only with fresh proof and rotates codes without disabling 2FA", async () => {
    await expect(store.beginTotpSetup(session)).rejects.toThrow("current authenticator");
    await expect(store.beginTotpSetup(session, "wrong-code")).rejects.toThrow();
    const setup = await store.beginTotpSetup(session, recovery[0]);
    expect((await store.securityStatus(session)).totpEnabled).toBe(true);
    await expect(store.beginTotpSetup(session, recovery[0])).rejects.toThrow();
    const other = await store.createSessionForUser(session.userId);
    const next = await store.confirmTotpSetup(session, currentTotpCode(setup.secret));
    expect(next.recoveryCodes).toHaveLength(10);
    await expect(store.getSession(other.id)).rejects.toThrow();
    await expect(store.confirmTotpSetup(session, currentTotpCode(setup.secret))).rejects.toThrow();
    expect((await dashboard(session)).statusCode).toBe(200);
    const login = await store.login("daniel@example.com", "Password123!");
    if (login.kind !== "two_factor_required") throw new Error("Expected 2FA");
    await expect(store.verifySecondFactor(login.challengeId, recovery[1])).rejects.toThrow();
    expect((await store.verifySecondFactor(login.challengeId, next.recoveryCodes[0])).secondFactorVerified).toBe(true);
  });

  it("requires native proof and rejects handoffs after parent logout", async () => {
    const verifier = "a".repeat(43);
    const mint = () => app.inject({ method: "POST", url: "/api/v1/auth/native-handoff", headers: { cookie: cookie(session) }, payload: { challenge: createHash("sha256").update(verifier).digest("base64url") } });
    const consume = (code: string, proof = verifier) => app.inject({ method: "POST", url: "/api/v1/auth/native-handoff/consume", payload: { code, verifier: proof } });
    const mismatch = (await mint()).json().code;
    expect((await consume(mismatch, "b".repeat(43))).statusCode).toBe(401);
    expect((await consume(mismatch)).statusCode).toBe(401);
    const expired = (await mint()).json().code;
    await store.revokeSession(session.id);
    expect((await consume(expired)).statusCode).toBe(401);
  });

  it("binds pending authenticator setup to its session and expires it", async () => {
    const setup = await store.beginTotpSetup(session, recovery[0]);
    const other = await store.createSessionForUser(session.userId);
    await expect(store.confirmTotpSetup(other, currentTotpCode(setup.secret))).rejects.toThrow("expired");
    store.users.get(session.userId)!.totpPendingExpiresAt = new Date(0).toISOString();
    await expect(store.confirmTotpSetup(session, currentTotpCode(setup.secret))).rejects.toThrow("expired");
    expect((await store.securityStatus(session)).totpEnabled).toBe(true);
  });
});
