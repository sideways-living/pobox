import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncPostOfficeDirectory, postOfficeDirectoryStatus, refreshPostOfficeDirectoryIfStale } from "../src/lctr/postOfficeDirectory.js";
import { PrismaStore } from "../src/store/prismaStore.js";
import { appVersion } from "../src/releases.js";

const url = process.env.POBOX_TEST_DATABASE_URL;
describe.skipIf(!url)("Directory publication and release acknowledgements (disposable PostgreSQL)", () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const other = new PrismaClient({ datasourceUrl: url });
  const key = "lctr:australia-post:directory";
  const row = (id = "directory-test", name = "South Melbourne") => ({ id, name, address1: "181 Clarendon St", suburb: "South Melbourne", state: "VIC", latitude: -37.832, longitude: 144.96 });
  const respond = (data: unknown) => ({ ok: true, json: async () => ({ data }) }) as Response;
  beforeEach(async () => {
    // These global-directory tests require an explicitly supplied disposable DB.
    await prisma.postOfficeDirectory.deleteMany();
    await prisma.integrationSyncState.deleteMany({ where: { key } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await prisma.postOfficeDirectory.deleteMany();
    await prisma.integrationSyncState.deleteMany({ where: { key } });
    await prisma.$disconnect(); await other.$disconnect();
  });

  it("refreshes idempotently and preserves user-managed offices", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Directory preservation" } });
    const office = await prisma.postOffice.create({ data: { workspaceId: workspace.id, name: "My office", address: "My address", phone: "My phone", latitude: -37, longitude: 145 } });
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(respond([{ ...row(), phone: "Old phone" }]));
      await syncPostOfficeDirectory(prisma);
      vi.mocked(fetch).mockResolvedValue(respond([row()]));
      await syncPostOfficeDirectory(other);
      expect(await prisma.postOfficeDirectory.count()).toBe(1);
      expect((await prisma.postOfficeDirectory.findUniqueOrThrow({ where: { sourceId: "directory-test" } })).phone).toBeNull();
      expect(await postOfficeDirectoryStatus(prisma)).toMatchObject({ status: "ok", rowCount: 1, activeRowCount: 1 });
      expect(await prisma.postOffice.findUnique({ where: { id: office.id } })).toMatchObject({ name: "My office", address: "My address", phone: "My phone" });
      await refreshPostOfficeDirectoryIfStale(prisma);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await prisma.postOffice.delete({ where: { id: office.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
    }
  });

  it("allows only one worker to fetch during a refresh", async () => {
    let release!: (value: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = syncPostOfficeDirectory(prisma);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await syncPostOfficeDirectory(other);
    expect(fetchMock).toHaveBeenCalledOnce();
    release(respond([row()]));
    await first;
    expect((await postOfficeDirectoryStatus(prisma)).status).toBe("ok");
  });

  it("rolls back partial publication and records failure without deleting the previous directory", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond([row()]));
    await syncPostOfficeDirectory(prisma);
    vi.mocked(fetch).mockResolvedValue(respond([row("directory-test", "Changed"), row("second", "Second")]));
    let writes = 0;
    const failing = prisma.$extends({ query: { postOfficeDirectory: { async upsert({ args, query }) {
      if (++writes === 2) throw new Error("simulated publication failure");
      return query(args);
    } } } });
    await expect(syncPostOfficeDirectory(failing as unknown as PrismaClient)).rejects.toThrow("simulated");
    expect(await prisma.postOfficeDirectory.findUnique({ where: { sourceId: "directory-test" } })).toMatchObject({ name: "South Melbourne", active: true });
    expect(await prisma.postOfficeDirectory.count()).toBe(1);
    expect((await postOfficeDirectoryStatus(prisma)).status).toBe("failed");
    vi.mocked(fetch).mockClear();
    await refreshPostOfficeDirectoryIfStale(prisma);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects empty and malformed imports and recovers expired leases", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond([row()]));
    await syncPostOfficeDirectory(prisma);
    for (const data of [[], null, [{ ...row(), latitude: 999 }]]) {
      vi.mocked(fetch).mockResolvedValue(respond(data));
      await expect(syncPostOfficeDirectory(prisma)).rejects.toThrow();
      expect((await postOfficeDirectoryStatus(prisma)).activeRowCount).toBe(1);
    }
    await prisma.integrationSyncState.update({ where: { key }, data: { status: "running", syncedAt: new Date(0) } });
    vi.mocked(fetch).mockResolvedValue(respond([row("replacement")]));
    await refreshPostOfficeDirectoryIfStale(prisma);
    expect((await postOfficeDirectoryStatus(prisma)).status).toBe("ok");
    expect(await prisma.postOfficeDirectory.findUnique({ where: { sourceId: "directory-test" } })).toMatchObject({ active: false });
  });

  it("serializes release dismissal across clients without moving seen state backwards", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Release test" } });
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", memberships: { create: { workspaceId: workspace.id, role: "MEMBER", status: "ACTIVE" } } } });
    const session = { id: "test", userId: user.id, expiresAt: new Date(Date.now() + 60000).toISOString() };
    try {
      const a = new PrismaStore(prisma), b = new PrismaStore(other);
      expect((await a.appChanges(session, workspace.id)).lastSeenVersion).toBeUndefined();
      await Promise.all([a.markAppChangesSeen(session, workspace.id, appVersion), b.markAppChangesSeen(session, workspace.id, "0.12.3")]);
      expect((await b.appChanges(session, workspace.id)).changes).toEqual([]);
      expect((await b.appChanges(session, workspace.id)).lastSeenVersion).toBe(appVersion);
    } finally {
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
