import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { appVersion } from "../src/releases.js";
import { buildServer } from "../src/api/server.js";
import { MemoryStore } from "../src/store/memoryStore.js";

describe("release notices", () => {
  let app: FastifyInstance;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildServer(store);
  });

  afterEach(async () => {
    await app.close();
  });

  async function loginCookie() {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "daniel@example.com", password: "Password123!" }
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((item) => item.name === "pobox_watch_session");
    expect(cookie?.value).toBeTruthy();
    markSecurityComplete("usr_daniel");
    return `pobox_watch_session=${cookie?.value}`;
  }

  function markSecurityComplete(userId: string) {
    const user = store.users.get(userId);
    if (!user) throw new Error(`Missing fixture user ${userId}.`);
    store.users.set(userId, {
      ...user,
      totpEnabled: true,
      totpSecretEncrypted: "test-secret",
      totpConfirmedAt: new Date().toISOString()
    });
    store.passkeyCredentials.set("test-passkey", {
      id: "test-passkey",
      userId,
      credentialId: "test-passkey",
      publicKey: Buffer.from("test-public-key"),
      counter: 0,
      transports: [],
      friendlyName: "Test passkey"
    });
  }

  it("keeps showing first-login changes until the popup is dismissed", async () => {
    const cookie = await loginCookie();

    const first = await app.inject({ method: "GET", url: "/api/v1/workspaces/ws_company/app/changes", headers: { cookie } });
    const firstBody = first.json();
    expect(first.statusCode).toBe(200);
    expect(firstBody.version).toBe(appVersion);
    expect(firstBody.changes.length).toBeGreaterThan(1);

    const beforeDismissal = await app.inject({ method: "GET", url: "/api/v1/workspaces/ws_company/app/changes", headers: { cookie } });
    expect(beforeDismissal.json().changes.length).toBe(firstBody.changes.length);

    const dismissal = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/ws_company/app/changes/seen",
      headers: { cookie },
      payload: { version: appVersion }
    });
    expect(dismissal.statusCode).toBe(200);
    expect(dismissal.json().lastSeenVersion).toBe(appVersion);
    expect(dismissal.json().changes).toHaveLength(0);
  });
});
