import { buildServer } from "./api/server.js";

const port = Number(process.env.PORT || 4175);
const host = process.env.HOST || "0.0.0.0";
const app = await buildServer();
await app.listen({ port, host });
