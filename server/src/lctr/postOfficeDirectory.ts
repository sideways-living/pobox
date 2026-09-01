import type { PrismaClient } from "@prisma/client";
import { fetchAllLctrPostOffices, rankedLocations, searchLctrPostOffices, type LctrPostOfficeLocation } from "./postOfficeLookup.js";

const syncKey = "lctr:australia-post:directory";
const staleAfterMs = 1000 * 60 * 60 * 24 * 7;

export async function searchPostOfficeDirectory(prisma: PrismaClient, query: string): Promise<LctrPostOfficeLocation[]> {
  let refreshError: unknown;
  try {
    await refreshPostOfficeDirectoryIfStale(prisma);
  } catch (error) {
    refreshError = error;
  }

  const localResults = await searchLocalDirectory(prisma, query);
  if (localResults.length > 0) return rankedLocations(localResults, query.trim().toLowerCase());
  if (refreshError) throw refreshError;
  return searchLctrPostOffices(query);
}

export async function refreshPostOfficeDirectoryIfStale(prisma: PrismaClient): Promise<void> {
  const state = await prisma.integrationSyncState.findUnique({ where: { key: syncKey } });
  if (state?.status === "running" && Date.now() - state.syncedAt.getTime() < 1000 * 60 * 30) return;
  if (state?.status === "ok" && Date.now() - state.syncedAt.getTime() < staleAfterMs) return;
  await syncPostOfficeDirectory(prisma);
}

export async function syncPostOfficeDirectory(prisma: PrismaClient): Promise<{ rowCount: number }> {
  const startedAt = new Date();
  await prisma.integrationSyncState.upsert({
    where: { key: syncKey },
    update: { status: "running", message: null },
    create: { key: syncKey, syncedAt: startedAt, status: "running" }
  });

  try {
    const locations = await fetchAllLctrPostOffices();
    for (const location of locations) {
      await prisma.postOfficeDirectory.upsert({
        where: { sourceId: location.sourceId },
        update: {
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

    await prisma.postOfficeDirectory.updateMany({
      where: { lastSeenAt: { lt: startedAt } },
      data: { active: false }
    });
    await prisma.integrationSyncState.update({
      where: { key: syncKey },
      data: { syncedAt: new Date(), status: "ok", message: null, rowCount: locations.length }
    });
    return { rowCount: locations.length };
  } catch (error) {
    await prisma.integrationSyncState.update({
      where: { key: syncKey },
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
    take: 100
  });

  return rows.map((row) => ({
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
