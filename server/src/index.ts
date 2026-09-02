import { buildServer } from "./api/server.js";
import { startConfiguredMailPoller } from "./mail/runtime.js";
import { createStore } from "./store/factory.js";

const port = Number(process.env.PORT || 4175);
const host = process.env.HOST || "0.0.0.0";
const store = createStore();
const app = await buildServer(store);
startConfiguredMailPoller(store);
await app.listen({ port, host });
