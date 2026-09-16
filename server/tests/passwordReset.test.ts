import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { MemoryStore } from "../src/store/memoryStore.js";
import { resetDigest } from "../src/auth/passwordReset.js";
import { buildServer } from "../src/api/server.js";

describe("password recovery", () => {
  let store: MemoryStore;
  beforeEach(async () => { store = new MemoryStore(); await store.seedDemo(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it("sends a TLS reset link and gives the same public response for unknown accounts", async () => {
    for (const [key, value] of Object.entries({ SMTP_HOST: "smtp.example.test", SMTP_USER: "mailer", SMTP_PASSWORD: "fixture-only", SMTP_FROM: "pobox@example.test", APP_BASE_URL: "https://pobox.watch" })) vi.stubEnv(key, value);
    const sendMail = vi.fn().mockResolvedValue({});
    const transport = vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const app = await buildServer(store);
    try {
      const send = (email: string) => app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email } });
      const known = await send("daniel@example.com");
      const unknown = await send("unknown@example.com");
      expect(known.statusCode).toBe(200);
      expect(known.body).toBe(unknown.body);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0].text).toContain("https://pobox.watch/#reset-password=");
      expect(transport.mock.calls[0][0]).toMatchObject({ requireTLS: true });
      expect(known.body).not.toContain("reset-password=");
    } finally { await app.close(); }
  });
  it("uses the unauthenticated local Postfix relay without TLS", async () => {
    for (const [key, value] of Object.entries({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "25", SMTP_FROM: "pobox.watch <noreply@pobox.watch>", APP_BASE_URL: "https://pobox.watch" })) vi.stubEnv(key, value);
    const sendMail = vi.fn().mockResolvedValue({});
    const transport = vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const app = await buildServer(store);
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: "daniel@example.com" } });
      expect(response.statusCode).toBe(200);
      expect(transport.mock.calls[0][0]).toMatchObject({
        host: "127.0.0.1", port: 25, secure: false, ignoreTLS: true, requireTLS: false
      });
      expect(transport.mock.calls[0][0]).not.toHaveProperty("auth.user");
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "pobox.watch <noreply@pobox.watch>" }));
    } finally { await app.close(); }
  });
  it("rejects an incomplete authenticated SMTP configuration", async () => {
    for (const [key, value] of Object.entries({ SMTP_HOST: "smtp.example.test", SMTP_USER: "mailer", SMTP_FROM: "pobox@example.test", APP_BASE_URL: "https://pobox.watch" })) vi.stubEnv(key, value);
    const transport = vi.spyOn(nodemailer, "createTransport");
    const app = await buildServer(store);
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: "daniel@example.com" } });
      expect(response.statusCode).toBe(503);
      expect(transport).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("does not issue links for missing or disabled accounts", async () => {
    expect(await store.requestPasswordReset("unknown@example.com")).toBeUndefined();
    const admin = await store.createSessionForUser("usr_daniel");
    await store.deleteUser(admin, "ws_company", "usr_sarah");
    expect(await store.requestPasswordReset("sarah@example.com")).toBeUndefined();
  });
  it("replaces earlier tokens, expires links and stores only hashes", async () => {
    const first = (await store.requestPasswordReset("daniel@example.com"))!;
    const next = (await store.requestPasswordReset("daniel@example.com"))!;
    expect(store.passwordResets.has(next)).toBe(false);
    await expect(store.resetPassword(first, "NewLongPassword123!")).rejects.toThrow("invalid or expired");
    store.passwordResets.get(resetDigest(next))!.expiresAt = 0;
    await expect(store.resetPassword(next, "NewLongPassword123!")).rejects.toThrow("invalid or expired");
  });
  it("consumes links once, revokes sessions, and preserves authenticator requirements", async () => {
    const session = await store.createSessionForUser("usr_daniel");
    store.users.get(session.userId)!.totpEnabled = true;
    const token = (await store.requestPasswordReset("daniel@example.com"))!;
    const results = await Promise.allSettled([store.resetPassword(token, "NewLongPassword123!"), store.resetPassword(token, "NewLongPassword123!")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(store.getSession(session.id)).rejects.toThrow();
    await expect(store.login("daniel@example.com", "Password123!")).rejects.toThrow();
    expect((await store.login("daniel@example.com", "NewLongPassword123!")).kind).toBe("two_factor_required");
  });
  it("requires the current password and invalidates issued reset links on change", async () => {
    const session = await store.createSessionForUser("usr_daniel");
    const token = (await store.requestPasswordReset("daniel@example.com"))!;
    await expect(store.changePassword(session, "wrong", "NewLongPassword123!")).rejects.toThrow("incorrect");
    await store.changePassword(session, "Password123!", "NewLongPassword123!");
    await expect(store.resetPassword(token, "AnotherPassword123!")).rejects.toThrow();
    await expect(store.getSession(session.id)).rejects.toThrow();
  });
  it("enforces security setup for changes and validates reset password length", async () => {
    const app = await buildServer(store);
    try {
      const session = await store.createSessionForUser("usr_daniel");
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/password/change", headers: { cookie: `pobox_watch_session=${session.id}` }, payload: { currentPassword: "Password123!", password: "NewLongPassword123!" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token: "a".repeat(43), password: "short" } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
