import type { PrismaClient } from "@prisma/client";
import { fetchAllLctrPostOffices, rankedLocations, searchLctrPostOffices, type LctrPostOfficeLocation } from "./postOfficeLookup.js";

const syncKey = "lctr:australia-post:directory";
const staleAfterMs = 1000 * 60 * 60 * 24 * 7;

export interface PostOfficeDirectoryStatus {
  status: string;
  rowCount: number;
  activeRowCount: number;
  syncedAt?: string;
  message?: string;
}

interface LocalDirectoryRow {
  sourceId: string;
  name: string;
  address: string;
  phone: string | null;
  suburb: string | null;
  postcode: string | null;
  state: string | null;
  latitude: unknown;
  longitude: unknown;
  hours: string | null;
}

export async function searchPostOfficeDirectory(prisma: PrismaClient, query: string): Promise<LctrPostOfficeLocation[]> {
  const localResults = await searchLocalDirectory(prisma, query);
  const status = await postOfficeDirectoryStatus(prisma);
  if (status.activeRowCount > 0) {
    void refreshPostOfficeDirectoryIfStale(prisma).catch(() => undefined);
  }
  if (localResults.length > 0) {
    return rankedLocations(localResults, query.trim().toLowerCase());
  }
  if (status.activeRowCount === 0) {
    void refreshPostOfficeDirectoryIfStale(prisma).catch(() => undefined);
  }
  return searchLctrPostOffices(query);
}

export async function postOfficeDirectoryStatus(prisma: PrismaClient): Promise<PostOfficeDirectoryStatus> {
  const [state, activeRowCount] = await Promise.all([
    prisma.integrationSyncState.findUnique({ where: { key: syncKey } }),
    prisma.postOfficeDirectory.count({ where: { active: true } })
  ]);

  return {
    status: state?.status ?? "not_imported",
    rowCount: state?.rowCount ?? 0,
    activeRowCount,
    syncedAt: state?.syncedAt.toISOString(),
    message: state?.message ?? undefined
  };
}

export async function refreshPostOfficeDirectoryIfStale(prisma: PrismaClient): Promise<void> {
  const state = await prisma.integrationSyncState.findUnique({ where: { key: syncKey } });
  if (state?.status === "running" && Date.now() - state.syncedAt.getTime() < 1000 * 60 * 30) return;
  if (state?.status === "ok" && Date.now() - state.syncedAt.getTime() < staleAfterMs) return;
  if (state?.status === "failed" && Date.now() - state.syncedAt.getTime() < 15 * 60 * 1000) return;
  await syncPostOfficeDirectory(prisma);
}

export async function syncPostOfficeDirectory(prisma: PrismaClient): Promise<{ rowCount: number }> {
  const startedAt = new Date();
  await prisma.integrationSyncState.createMany({
    data: [{ key: syncKey, syncedAt: new Date(0), status: "not_imported" }],
    skipDuplicates: true
  });
  // Claim a recoverable lease across workers; network I/O stays outside the transaction.
  const claimed = await prisma.integrationSyncState.updateMany({
    where: { key: syncKey, OR: [{ status: { not: "running" } }, { syncedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } }] },
    data: { syncedAt: startedAt, status: "running", message: null }
  });
  if (!claimed.count) return { rowCount: (await postOfficeDirectoryStatus(prisma)).rowCount };

  try {
    const locations = await fetchAllLctrPostOffices();
    if (!locations.length) throw new Error("Directory returned no valid locations; the previous directory was retained.");
    await prisma.$transaction(async (tx) => {
      const lease = await tx.integrationSyncState.updateMany({
        where: { key: syncKey, status: "running", syncedAt: startedAt },
        data: { status: "running" }
      });
      if (!lease.count) throw new Error("Directory refresh lease expired; newer refresh retained.");
      for (const location of locations) {
        await tx.postOfficeDirectory.upsert({
          where: { sourceId: location.sourceId },
          update: {
            name: location.name,
            address: location.address,
            phone: location.phone ?? null,
            suburb: location.suburb ?? null,
            postcode: location.postcode ?? null,
            state: location.state ?? null,
            latitude: location.latitude,
            longitude: location.longitude,
            hours: location.hours ?? null,
            active: true,
            lastSeenAt: startedAt
          },
          create: {
            sourceId: location.sourceId,
            name: location.name,
            address: location.address,
            phone: location.phone,
            suburb: location.suburb,
            postcode: location.postcode,
            state: location.state,
            latitude: location.latitude,
            longitude: location.longitude,
            hours: location.hours,
            active: true,
            lastSeenAt: startedAt
          }
        });
      }

      await tx.postOfficeDirectory.updateMany({
        where: { lastSeenAt: { lt: startedAt } },
        data: { active: false }
      });
      await tx.integrationSyncState.update({
        where: { key: syncKey },
        data: { syncedAt: new Date(), status: "ok", message: null, rowCount: locations.length }
      });
    }, { timeout: 120000 });
    return { rowCount: locations.length };
  } catch (error) {
    await prisma.integrationSyncState.updateMany({
      where: { key: syncKey, status: "running", syncedAt: startedAt },
      data: {
        syncedAt: new Date(),
        status: "failed",
        message: error instanceof Error ? error.message : "Post office directory sync failed."
      }
    });
    throw error;
  }
}

async function searchLocalDirectory(prisma: PrismaClient, query: string): Promise<LctrPostOfficeLocation[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2) return [];
  const postcodeSearch = /^\d{4}$/.test(normalizedQuery);
  const rows = await prisma.postOfficeDirectory.findMany({
    where: {
      active: true,
      OR: postcodeSearch
        ? [{ postcode: { startsWith: normalizedQuery } }]
        : [
            { suburb: { contains: normalizedQuery, mode: "insensitive" } },
            { name: { contains: normalizedQuery, mode: "insensitive" } },
            { address: { contains: normalizedQuery, mode: "insensitive" } }
          ]
    },
    take: 500
  });

  return (rows as LocalDirectoryRow[]).map((row) => ({
    sourceId: row.sourceId,
    name: row.name,
    address: row.address,
    phone: row.phone ?? undefined,
    suburb: row.suburb ?? undefined,
    postcode: row.postcode ?? undefined,
    state: row.state ?? undefined,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    hours: row.hours ?? undefined
  }));
}
