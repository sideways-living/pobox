import { buildServer } from "./api/server.js";
import { createStore } from "./store/factory.js";

const port = Number(process.env.PORT || 4175);
const host = process.env.HOST || "0.0.0.0";
const app = await buildServer(createStore());
await app.listen({ port, host });
