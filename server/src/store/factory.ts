import type { AppStore } from "./types.js";
import { MemoryStore } from "./memoryStore.js";
import { PrismaStore } from "./prismaStore.js";

export function createStore(): AppStore {
  if (process.env.MAILBOX_STORAGE === "prisma") {
    return new PrismaStore();
  }
  return new MemoryStore();
}
