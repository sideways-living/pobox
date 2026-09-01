import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { appVersion, changesSince } from "../releases.js";
import { realtimeHub } from "../realtime/hub.js";
import { MemoryStore } from "../store/memoryStore.js";
import type { AppStore } from "../store/types.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../store/types.js";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const twoFactorSchema = z.object({ challengeId: z.string().min(16), code: z.string().min(6).max(32) });
const totpConfirmSchema = z.object({ code: z.string().min(6).max(32) });
const passkeyRegistrationSchema = z.object({ response: z.any(), friendlyName: z.string().min(1).max(80).optional() });
const passkeyAuthenticationOptionsSchema = z.object({ email: z.string().email().optional() });
const passkeyAuthenticationSchema = z.object({ response: z.any() });
const postOfficeLookupSchema = z.object({ query: z.string().min(2).max(80), state: z.string().length(3).optional() });
const collectSchema = z.object({ source: z.enum(["IPHONE", "MACOS", "WEB", "ADMIN", "NOTIFICATION"]).default("WEB") });
const simulateSchema = z.object({
  mailboxNumber: z.string().min(2),
  providerMessageId: z.string().optional()
});
const inviteSchema = z.object({ email: z.string().email(), role: z.enum(["ADMIN", "MEMBER"]) });
const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(["ADMIN", "MEMBER"])
});
const createPostOfficeSchema = z.object({
  name: z.string().min(1).max(160),
  address: z.string().min(1).max(240),
  phone: z.string().max(80).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  geofenceRadius: z.number().int().min(25).max(5000).default(200)
});
const createMailboxSchema = z.object({
  postOfficeId: z.string().min(1),
  name: z.string().min(1).max(160),
  boxNumber: z.string().min(1).max(40)
});
const sessionCookieName = "pobox_watch_session";
const legacySessionCookieName = "mailbox_session";

function sessionCookie(cookies: Record<string, string | undefined>) {
  return cookies[sessionCookieName] ?? cookies[legacySessionCookieName];
}

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

  async function securedSession(request: { cookies: Record<string, string | undefined> }, workspaceId: string) {
    const session = await store.getSession(sessionCookie(request.cookies));
    const status = await store.securityStatus(session);
    if (status.passkeyCount < 1 || !status.totpEnabled) {
      throw new ForbiddenError("Passkey and authenticator 2FA setup are required before using pobox.watch.");
    }
    await store.requireMember(session, workspaceId);
    return session;
  }

  app.get("/api/health", async () => ({
    ok: true,
    service: "pobox-watch-api",
    storage: process.env.POBOX_WATCH_STORAGE ?? process.env.MAILBOX_STORAGE ?? "memory",
    timestamp: new Date().toISOString()
  }));

  app.post("/api/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await store.login(body.email, body.password);
    if (result.kind === "two_factor_required") {
      return { ok: false, twoFactorRequired: true, challengeId: result.challengeId, expiresAt: result.expiresAt, methods: result.methods };
    }
    const session = result;
    reply.setCookie(sessionCookieName, session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(session.expiresAt)
    });
    return { ok: true, expiresAt: session.expiresAt, previousLoginAt: session.previousLoginAt };
  });

  app.post("/api/v1/auth/2fa/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = twoFactorSchema.parse(request.body);
    const session = await store.verifySecondFactor(body.challengeId, body.code);
    reply.setCookie(sessionCookieName, session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(session.expiresAt)
    });
    return { ok: true, expiresAt: session.expiresAt, previousLoginAt: session.previousLoginAt };
  });

  app.post("/api/v1/auth/logout", async (_request, reply) => {
    reply.clearCookie(sessionCookieName, { path: "/" });
    reply.clearCookie(legacySessionCookieName, { path: "/" });
    return { ok: true };
  });

  app.post("/api/v1/auth/passkeys/registration-options", async (request) => {
    const session = await store.getSession(sessionCookie(request.cookies));
    return store.beginPasskeyRegistration(session);
  });

  app.post("/api/v1/auth/passkeys/register", async (request) => {
    const body = passkeyRegistrationSchema.parse(request.body);
    const session = await store.getSession(sessionCookie(request.cookies));
    return store.verifyPasskeyRegistration(session, body.response, body.friendlyName);
  });

  app.post("/api/v1/auth/passkeys/authentication-options", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const body = passkeyAuthenticationOptionsSchema.parse(request.body ?? {});
    return store.beginPasskeyAuthentication(body.email);
  });

  app.post("/api/v1/auth/passkeys/authenticate", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = passkeyAuthenticationSchema.parse(request.body);
    const result = await store.verifyPasskeyAuthentication(body.response);
    if (result.kind === "two_factor_required") {
      return { ok: false, twoFactorRequired: true, challengeId: result.challengeId, expiresAt: result.expiresAt, methods: result.methods };
    }
    const session = result;
    reply.setCookie(sessionCookieName, session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(session.expiresAt)
    });
    return { ok: true, expiresAt: session.expiresAt, previousLoginAt: session.previousLoginAt };
  });

  app.get("/api/v1/auth/security", async (request) => {
    const session = await store.getSession(sessionCookie(request.cookies));
    return store.securityStatus(session);
  });

  app.post("/api/v1/auth/2fa/setup", async (request) => {
    const session = await store.getSession(sessionCookie(request.cookies));
    return store.beginTotpSetup(session);
  });

  app.post("/api/v1/auth/2fa/confirm", async (request) => {
    const body = totpConfirmSchema.parse(request.body);
    const session = await store.getSession(sessionCookie(request.cookies));
    return store.confirmTotpSetup(session, body.code);
  });

  app.post("/api/v1/auth/2fa/disable", async (request) => {
    const session = await store.getSession(sessionCookie(request.cookies));
    await store.requireMember(session, "ws_company");
    throw new ForbiddenError("Authenticator 2FA is mandatory for pobox.watch accounts.");
  });

  app.get("/api/v1/workspaces/:workspaceId/app/changes", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const query = request.query as { since?: string };
    const session = await securedSession(request, workspaceId);
    const member = await store.requireMember(session, workspaceId);
    return {
      version: appVersion,
      since: query.since,
      changes: changesSince(query.since, member.role)
    };
  });

  app.get("/api/v1/workspaces/:workspaceId/dashboard", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await securedSession(request, workspaceId);
    return store.dashboard(session, workspaceId);
  });

  app.post("/api/v1/workspaces/:workspaceId/mailboxes/:mailboxId/collect", async (request) => {
    const { workspaceId, mailboxId } = request.params as { workspaceId: string; mailboxId: string };
    const body = collectSchema.parse(request.body ?? {});
    const session = await securedSession(request, workspaceId);
    const event = await store.collectMailbox(session, workspaceId, mailboxId, body.source);
    realtimeHub.emitWorkspace(workspaceId, { type: "dashboard.updated", snapshot: await store.dashboard(session, workspaceId) });
    return event;
  });

  app.post("/api/v1/workspaces/:workspaceId/team/invitations", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = inviteSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    return store.inviteMember(session, workspaceId, body.email, body.role);
  });

  app.get("/api/v1/workspaces/:workspaceId/team/members", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await securedSession(request, workspaceId);
    return store.listMembers(session, workspaceId);
  });

  app.get("/api/v1/workspaces/:workspaceId/review-items", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await securedSession(request, workspaceId);
    return store.listReviewItems(session, workspaceId);
  });

  app.get("/api/v1/workspaces/:workspaceId/post-office-locations/search", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const query = postOfficeLookupSchema.parse(request.query);
    const session = await securedSession(request, workspaceId);
    return store.searchPostOfficeLocations(session, workspaceId, query.query);
  });

  app.post("/api/v1/workspaces/:workspaceId/team/users", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = createUserSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const member = await store.createUser(session, workspaceId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "dashboard.updated", snapshot: await store.dashboard(session, workspaceId) });
    return member;
  });

  app.post("/api/v1/workspaces/:workspaceId/post-offices", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = createPostOfficeSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const postOffice = await store.createPostOffice(session, workspaceId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "dashboard.updated", snapshot: await store.dashboard(session, workspaceId) });
    return postOffice;
  });

  app.post("/api/v1/workspaces/:workspaceId/mailboxes", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = createMailboxSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const mailbox = await store.createMailbox(session, workspaceId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "dashboard.updated", snapshot: await store.dashboard(session, workspaceId) });
    return mailbox;
  });

  app.post("/api/v1/workspaces/:workspaceId/dev/simulate-mail", async (request) => {
    if (process.env.NODE_ENV === "production") throw new ForbiddenError("Development simulation is disabled in production.");
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await securedSession(request, workspaceId);
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
    await securedSession(request, workspaceId);
    realtimeHub.add(workspaceId, socket);
    socket.send(JSON.stringify({ type: "connected", workspaceId }));
  });

  const webDistPath =
    process.env.WEB_DIST_PATH ||
    [path.resolve(process.cwd(), "web/dist"), path.resolve(process.cwd(), "../web/dist")].find((candidate) =>
      existsSync(candidate)
    );
  if (process.env.NODE_ENV === "production" && webDistPath && existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found." });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
