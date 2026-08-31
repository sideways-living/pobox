import { PrismaStore } from "../src/store/prismaStore.js";

const previousPoboxWatchSeedDemo = process.env.POBOX_WATCH_SEED_DEMO;
process.env.POBOX_WATCH_SEED_DEMO = "true";
await new PrismaStore().seedDemo();
process.env.POBOX_WATCH_SEED_DEMO = previousPoboxWatchSeedDemo;
console.log("Seeded pobox.watch demo workspace, users, post offices, and PO boxes.");
