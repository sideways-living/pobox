import { PrismaStore } from "../src/store/prismaStore.js";

const previous = process.env.MAILBOX_SEED_DEMO;
process.env.MAILBOX_SEED_DEMO = "true";
await new PrismaStore().seedDemo();
process.env.MAILBOX_SEED_DEMO = previous;
console.log("Seeded Mailbox demo workspace, users, post offices, and mailboxes.");
