import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { appVersion } from "../releases.js";
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
const nativeHandoffConsumeSchema = z.object({ code: z.string().min(32).max(128), verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) });
const postOfficeLookupSchema = z.object({ query: z.string().min(2).max(80), state: z.string().length(3).optional() });
const collectSchema = z.object({ expectedUpdatedAt: z.string().datetime(), source: z.enum(["IPHONE", "MACOS", "WEB", "ADMIN", "NOTIFICATION"]).default("WEB") });
const inviteSchema = z.object({ email: z.string().email(), role: z.enum(["ADMIN", "MEMBER"]) });
const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(["ADMIN", "MEMBER"])
});
const updateUserSchema = z.object({
  expectedVersion: z.string().min(1).max(100),
  email: z.string().email().optional(),
  displayName: z.string().min(1).max(120).optional(),
  role: z.enum(["ADMIN", "MEMBER"]).optional(),
  status: z.enum(["INVITED", "ACTIVE", "DISABLED"]).optional()
}).refine((input) => Object.keys(input).length > 0, { message: "At least one field is required." });
const createPostOfficeSchema = z.object({
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().min(1).max(240),
  phone: z.string().max(80).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  geofenceRadius: z.number().int().min(25).max(5000).default(200)
});
const updatePostOfficeSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  name: z.string().trim().min(1).max(160).optional(),
  address: z.string().trim().min(1).max(240).optional(),
  phone: z.string().max(80).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geofenceRadius: z.number().int().min(25).max(5000).optional()
}).refine((input) => Object.keys(input).length > 0, { message: "At least one field is required." });
const createMailboxSchema = z.object({
  postOfficeId: z.string().min(1),
  name: z.string().min(1).max(160).optional(),
  boxNumber: z.string().trim().min(1).max(40)
});
const updateMailboxSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  postOfficeId: z.string().min(1).optional(),
  boxNumber: z.string().trim().min(1).max(40).optional()
}).refine((input) => Object.keys(input).length > 0, { message: "At least one field is required." });
const resolveReviewSchema = z.union([
  z.object({ mailboxId: z.string().min(1) }).strict(),
  z.object({ newMailbox: z.object({ postOfficeId: z.string().min(1), boxNumber: z.string().trim().min(1).max(40).regex(/[a-z0-9]/i) }).strict() }).strict()
]);
const releaseSeenSchema = z.object({
  version: z.string().min(1).max(40).default(appVersion)
}).refine((input) => input.version === appVersion, { message: "Release version does not match the current app version." });
const sessionCookieName = "pobox_watch_session";
const legacySessionCookieName = "mailbox_session";

function sessionCookie(cookies: Record<string, string | undefined>) {
  return cookies[sessionCookieName] ?? cookies[legacySessionCookieName];
}

export async function buildServer(store: AppStore = new MemoryStore()) {
  await store.seedDemo();
  const app = Fastify({ logger: true });
  const nativeHandoffCodes = new Map<string, { sessionId: string; expiresAt: number; challenge: string }>();
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "https://*.apple-mapkit.com", "https://cdn.apple-mapkit.com"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "https://cdn.apple-mapkit.com"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "https:", "'unsafe-inline'", "https://cdn.apple-mapkit.com"],
        connectSrc: ["'self'", "https://*.apple-mapkit.com", "https://cdn.apple-mapkit.com"],
        workerSrc: ["'self'", "blob:", "https://*.apple-mapkit.com", "https://cdn.apple-mapkit.com"]
      }
    }
  });
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
    if (status.passkeyCount < 1 || !status.totpEnabled || !session.secondFactorVerified) {
      throw new ForbiddenError("Passkey and authenticator 2FA setup are required before using pobox.watch.");
    }
    await store.requireMember(session, workspaceId);
    return session;
  }

  function setSessionCookie(reply: FastifyReply, session: { id: string; expiresAt: string }) {
    reply.setCookie(sessionCookieName, session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(session.expiresAt)
    });
  }

  async function securedNativeSession(request: { cookies: Record<string, string | undefined> }) {
    const session = await store.getSession(sessionCookie(request.cookies));
    const status = await store.securityStatus(session);
    if (status.passkeyCount < 1 || !status.totpEnabled || !session.secondFactorVerified) {
      throw new ForbiddenError("Passkey and authenticator 2FA setup are required before returning to the pobox.watch app.");
    }
    await store.requireMember(session, "ws_company");
    return session;
  }

  app.get("/api/health", async () => ({
    ok: true,
    service: "pobox-watch-api",
    version: appVersion,
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
    setSessionCookie(reply, session);
    return { ok: true, expiresAt: session.expiresAt, previousLoginAt: session.previousLoginAt };
  });

  app.post("/api/v1/auth/2fa/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = twoFactorSchema.parse(request.body);
    const session = await store.verifySecondFactor(body.challengeId, body.code);
    setSessionCookie(reply, session);
    return { ok: true, expiresAt: session.expiresAt, previousLoginAt: session.previousLoginAt };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    await store.revokeSession(request.cookies[sessionCookieName]);
    await store.revokeSession(request.cookies[legacySessionCookieName]);
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
    setSessionCookie(reply, session);
    return { ok: true, expiresAt: session.expiresAt, previousLoginAt: session.previousLoginAt };
  });

  app.post("/api/v1/auth/native-handoff", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request) => {
    const session = await securedNativeSession(request);
    const { challenge } = z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(request.body);
    const code = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 1000 * 60 * 2;
    for (const [key, value] of nativeHandoffCodes) if (value.expiresAt <= Date.now()) nativeHandoffCodes.delete(key);
    nativeHandoffCodes.set(code, { sessionId: session.id, expiresAt, challenge });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.post("/api/v1/auth/native-handoff/consume", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = nativeHandoffConsumeSchema.parse(request.body);
    const handoff = nativeHandoffCodes.get(body.code);
    nativeHandoffCodes.delete(body.code);
    if (!handoff || handoff.expiresAt < Date.now()) throw new UnauthorizedError("Native app sign-in link expired. Please try again.");
    if (createHash("sha256").update(body.verifier).digest("base64url") !== handoff.challenge) throw new UnauthorizedError("Native app sign-in proof does not match. Please try again.");
    const parent = await securedNativeSession({ cookies: { [sessionCookieName]: handoff.sessionId } });
    const session = await store.createSessionForUser(parent.userId);
    setSessionCookie(reply, session);
    return { ok: true, expiresAt: session.expiresAt, previousLoginAt: session.previousLoginAt };
  });

  app.get("/api/v1/auth/security", async (request) => {
    const session = await store.getSession(sessionCookie(request.cookies));
    return store.securityStatus(session);
  });

  app.post("/api/v1/auth/2fa/setup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const session = await store.getSession(sessionCookie(request.cookies));
    const body = z.object({ proof: z.string().max(128).optional() }).parse(request.body ?? {});
    return store.beginTotpSetup(session, body.proof);
  });

  app.post("/api/v1/auth/2fa/confirm", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
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
    const session = await securedSession(request, workspaceId);
    return store.appChanges(session, workspaceId);
  });

  app.post("/api/v1/workspaces/:workspaceId/app/changes/seen", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = releaseSeenSchema.parse(request.body ?? {});
    const session = await securedSession(request, workspaceId);
    return store.markAppChangesSeen(session, workspaceId, body.version);
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
    const event = await store.collectMailbox(session, workspaceId, mailboxId, body.source, body.expectedUpdatedAt);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
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

  app.post("/api/v1/workspaces/:workspaceId/review-items/:reviewItemId/resolve", async (request) => {
    const { workspaceId, reviewItemId } = request.params as { workspaceId: string; reviewItemId: string };
    const body = resolveReviewSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const result = await store.resolveReviewItem(session, workspaceId, reviewItemId, "mailboxId" in body ? body.mailboxId : "", "newMailbox" in body ? body.newMailbox : undefined);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return result;
  });

  app.post("/api/v1/workspaces/:workspaceId/review-items/:reviewItemId/mark-resolved", async (request, reply) => {
    const { workspaceId, reviewItemId } = request.params as { workspaceId: string; reviewItemId: string };
    const session = await securedSession(request, workspaceId);
    await store.markReviewItemResolved(session, workspaceId, reviewItemId);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return reply.code(204).send();
  });

  app.post("/api/v1/workspaces/:workspaceId/review-items/:reviewItemId/dismiss", async (request, reply) => {
    const { workspaceId, reviewItemId } = request.params as { workspaceId: string; reviewItemId: string };
    const session = await securedSession(request, workspaceId);
    await store.dismissReviewItem(session, workspaceId, reviewItemId);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return reply.code(204).send();
  });

  app.get("/api/v1/workspaces/:workspaceId/post-office-locations/search", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const query = postOfficeLookupSchema.parse(request.query);
    const session = await securedSession(request, workspaceId);
    return store.searchPostOfficeLocations(session, workspaceId, query.query);
  });

  app.get("/api/v1/workspaces/:workspaceId/post-office-locations/status", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await securedSession(request, workspaceId);
    return store.postOfficeDirectoryStatus(session, workspaceId);
  });

  app.post("/api/v1/workspaces/:workspaceId/post-office-locations/sync", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const session = await securedSession(request, workspaceId);
    return store.syncPostOfficeDirectory(session, workspaceId);
  });

  app.post("/api/v1/workspaces/:workspaceId/team/users", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = createUserSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const member = await store.createUser(session, workspaceId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return member;
  });

  app.patch("/api/v1/workspaces/:workspaceId/team/users/:userId", async (request) => {
    const { workspaceId, userId } = request.params as { workspaceId: string; userId: string };
    const body = updateUserSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const member = await store.updateUser(session, workspaceId, userId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return member;
  });

  app.delete("/api/v1/workspaces/:workspaceId/team/users/:userId", async (request, reply) => {
    const { workspaceId, userId } = request.params as { workspaceId: string; userId: string };
    const session = await securedSession(request, workspaceId);
    await store.deleteUser(session, workspaceId, userId);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return reply.code(204).send();
  });

  app.post("/api/v1/workspaces/:workspaceId/post-offices", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = createPostOfficeSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const postOffice = await store.createPostOffice(session, workspaceId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return postOffice;
  });

  app.patch("/api/v1/workspaces/:workspaceId/post-offices/:postOfficeId", async (request) => {
    const { workspaceId, postOfficeId } = request.params as { workspaceId: string; postOfficeId: string };
    const body = updatePostOfficeSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const postOffice = await store.updatePostOffice(session, workspaceId, postOfficeId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return postOffice;
  });

  app.delete("/api/v1/workspaces/:workspaceId/post-offices/:postOfficeId", async (request, reply) => {
    const { workspaceId, postOfficeId } = request.params as { workspaceId: string; postOfficeId: string };
    const session = await securedSession(request, workspaceId);
    await store.deletePostOffice(session, workspaceId, postOfficeId);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return reply.code(204).send();
  });

  app.post("/api/v1/workspaces/:workspaceId/mailboxes", async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = createMailboxSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const mailbox = await store.createMailbox(session, workspaceId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return mailbox;
  });

  app.patch("/api/v1/workspaces/:workspaceId/mailboxes/:mailboxId", async (request) => {
    const { workspaceId, mailboxId } = request.params as { workspaceId: string; mailboxId: string };
    const body = updateMailboxSchema.parse(request.body);
    const session = await securedSession(request, workspaceId);
    const mailbox = await store.updateMailbox(session, workspaceId, mailboxId, body);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return mailbox;
  });

  app.delete("/api/v1/workspaces/:workspaceId/mailboxes/:mailboxId", async (request, reply) => {
    const { workspaceId, mailboxId } = request.params as { workspaceId: string; mailboxId: string };
    const session = await securedSession(request, workspaceId);
    await store.deleteMailbox(session, workspaceId, mailboxId);
    realtimeHub.emitWorkspace(workspaceId, { type: "workspace.changed" });
    return reply.code(204).send();
  });

  app.get("/api/v1/workspaces/:workspaceId/realtime", { websocket: true }, async (socket, request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    try {
      await securedSession(request, workspaceId);
      realtimeHub.add(workspaceId, socket, async () => { await securedSession(request, workspaceId); });
      socket.send(JSON.stringify({ type: "connected", workspaceId }));
    } catch { socket.close(1008, "Workspace access denied"); }
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
