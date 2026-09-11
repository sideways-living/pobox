// Local browser fixture only. Never imported by the application entry point.
import { buildServer } from "../../src/api/server.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV === "production") throw new Error("Test fixture cannot run in production.");
const store = new MemoryStore();
const app = await buildServer(store);
await app.register(fastifyStatic, { root: fileURLToPath(new URL("../../../web/dist", import.meta.url)) });
const session = await store.login("daniel@example.com", "Password123!");
if (session.kind !== "session") throw new Error("Expected fixture session");
store.users.get("usr_daniel")!.totpEnabled = true;
store.passkeyCredentials.set("fixture", { id: "fixture", userId: "usr_daniel", credentialId: "fixture", publicKey: Buffer.from("fixture"), counter: 0, transports: [], friendlyName: "Fixture" });
await store.processIncomingMail({ workspaceId: "ws_company", provider: "gmail", providerMessageId: "fixture-letter", sender: "notice@example.test", subject: "Mail2Day: PO Box 1234 has mail", receivedAt: "2026-09-10T01:00:00Z" });
const flagged = store.mailboxes.get("box_1234")!;
store.mailboxes.set(flagged.id, { ...flagged, parcelWaiting: true, latestParcelNotificationAt: "2026-09-11T02:00:00Z" });
for (const [id, subject] of [["missing", "Mail2Day: PO Box 3020 has mail"], ["match", "Unclear parcel notification"], ["ignore", "Promotional newsletter"]]) {
  await store.processIncomingMail({ workspaceId: "ws_company", provider: "gmail", providerMessageId: id, subject, sender: "notice@example.test", receivedAt: "2026-09-12T01:23:00.000Z", bodyPreview: "<p>Please collect your item.</p><p>Bring photo identification.</p>" });
}
await app.listen({ host: "127.0.0.1", port: 4189 });
console.log(`REVIEW_SESSION=${session.id}`);
