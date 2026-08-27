import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import { realtimeHub } from "../realtime/hub.js";
import { MemoryStore } from "../store/memoryStore.js";
import type { AppStore } from "../store/types.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../store/types.js";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const collectSchema = z.object({ source: z.enum(["IPHONE", "MACOS", "WEB", "ADMIN", "NOTIFICATION"]).default("WEB") });
const simulateSchema = z.object({
  mailboxNumber: z.string().min(2),
  providerMessageId: z.string().optional()
});
const inviteSchema = z.object({ email: z.string().email(), role: z.enum(["ADMIN", "MEMBER"]) });

export async function buildServer(store: AppStore = new MemoryStore()) {
  await store.seedDemo();
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await app.register(cookie, { secret: process.env.SESSION_SECRET || "dev-session-secret-change-me" });
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true
  });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnauthorizedError) return reply.code(401).send({ error: error.message });
    if (error instanceof ForbiddenError) return reply.code(403).send({ error: error.message });
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
    if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request.", details: error.issues });
    app.log.error(error);
    return reply.code(500).send({ error: "Internal server error." });
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "mailbox-api",
    storage: process.env.MAILBOX_STORAGE || "memory",
    timestamp: new Date().toISOString()
  }));

  app.post("/api/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const session = await store.login(body.email, body.password);
    reply.setCookie("mailbox_session", session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(session.expiresAt)
    });
    return { ok: true, expiresAt: session.expiresAt };
  });

  app.post("/api/v1/auth/logout", async (_request, reply) => {
    reply.clearCookie("mailbox_session", { path: "/" });
    return { ok: true };
  });

  app.post("/api/v1/auth/passkeys/registration-options", async () => ({
    status: "NOT_CONFIGURED",
    message: "WebAuthn dependency and schema are present; production RP settings must be configured before enabling registration."
  }));

  app.get("/api/v1/workspaces/:workspaceId/dashboard", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await store.getSession(request.cookies.mailbox_session);
    return store.dashboard(session, workspaceId);
  });

  app.post("/api/v1/workspaces/:workspaceId/mailboxes/:mailboxId/collect", async (request) => {
    const { workspaceId, mailboxId } = request.params as { workspaceId: string; mailboxId: string };
    const body = collectSchema.parse(request.body ?? {});
    const session = await store.getSession(request.cookies.mailbox_session);
    const event = await store.collectMailbox(session, workspaceId, mailboxId, body.source);
    realtimeHub.emitWorkspace(workspaceId, { type: "dashboard.updated", snapshot: await store.dashboard(session, workspaceId) });
    return event;
  });

  app.post("/api/v1/workspaces/:workspaceId/team/invitations", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = inviteSchema.parse(request.body);
    const session = await store.getSession(request.cookies.mailbox_session);
    return store.inviteMember(session, workspaceId, body.email, body.role);
  });

  app.post("/api/v1/workspaces/:workspaceId/dev/simulate-mail", async (request) => {
    if (process.env.NODE_ENV === "production") throw new ForbiddenError("Development simulation is disabled in production.");
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await store.getSession(request.cookies.mailbox_session);
    await store.requireMember(session, workspaceId);
    const body = simulateSchema.parse(request.body);
    const result = await store.processIncomingMail({
      workspaceId,
      provider: "mock",
      providerMessageId: body.providerMessageId ?? `dev-${body.mailboxNumber}-${Date.now()}`,
      sender: "mailroom@example.com",
      subject: `There is mail in PO Box ${body.mailboxNumber}`,
      receivedAt: new Date().toISOString()
    });
    realtimeHub.emitWorkspace(workspaceId, { type: "dashboard.updated", snapshot: await store.dashboard(session, workspaceId), result });
    return result;
  });

  app.get("/api/v1/workspaces/:workspaceId/realtime", { websocket: true }, async (socket, request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await store.getSession(request.cookies.mailbox_session);
    await store.requireMember(session, workspaceId);
    realtimeHub.add(workspaceId, socket);
    socket.send(JSON.stringify({ type: "connected", workspaceId }));
  });

  return app;
}
