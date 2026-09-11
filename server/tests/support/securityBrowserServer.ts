// Isolated local fixture; no real accounts, mail credentials or external APIs.
import { buildServer } from "../../src/api/server.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV === "production") throw new Error("Test fixture cannot run in production.");
process.env.WEBAUTHN_ORIGIN = "http://localhost:4190";
process.env.WEBAUTHN_RP_ID = "localhost";
const app = await buildServer(new MemoryStore());
await app.register(fastifyStatic, { root: fileURLToPath(new URL("../../../web/dist", import.meta.url)) });
await app.listen({ host: "127.0.0.1", port: 4190 });
