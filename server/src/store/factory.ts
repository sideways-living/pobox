import type { AppStore } from "./types.js";
import { MemoryStore } from "./memoryStore.js";
import { PrismaStore } from "./prismaStore.js";

export function createStore(): AppStore {
  if ((process.env.POBOX_WATCH_STORAGE ?? process.env.MAILBOX_STORAGE) === "prisma") {
    return new PrismaStore();
  }
  if (process.env.NODE_ENV === "production") throw new Error("Production requires POBOX_WATCH_STORAGE=prisma for durable mail processing.");
  return new MemoryStore();
}
