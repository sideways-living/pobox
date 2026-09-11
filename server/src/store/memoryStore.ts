import argon2 from "argon2";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import { nanoid } from "nanoid";
import { decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, recoveryCodeMatches, totpUri, verifyTotp } from "../auth/totp.js";
import { challengeFromClientData, webAuthnConfig } from "../auth/webauthn.js";
import type {
  AuthChallenge,
  AuditEvent,
  CollectionEvent,
  CollectionSource,
  DashboardSnapshot,
  MailEvent,
  Mailbox,
  PostOffice,
  Session,
  User,
  Workspace,
  WorkspaceMember
} from "../domain.js";
import { parseMailNotification } from "../parser/mailParser.js";
import { mailText } from "../parser/mailText.js";
import type { PostOfficeDirectoryStatus } from "../lctr/postOfficeDirectory.js";
import { searchLctrPostOffices, type LctrPostOfficeLocation } from "../lctr/postOfficeLookup.js";
import { appVersion, changesAfterVersion } from "../releases.js";
import type {
  AppStore,
  AppChangesResult,
  ConfirmTotpResult,
  CreateMailboxInput,
  CreatePostOfficeInput,
  CreateUserInput,
  IncomingMailResult,
  IncomingProviderMessage,
  LoginResult,
  PasskeyAuthenticationOptions,
  PasskeyRegistrationOptions,
  ReviewItem,
  SecurityStatus,
  TeamMemberSummary,
  UpdateMailboxInput,
  UpdatePostOfficeInput,
  UpdateUserInput
} from "./types.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "./types.js";

export class MemoryStore implements AppStore {
  users = new Map<string, User>();
  workspaces = new Map<string, Workspace>();
  members = new Map<string, WorkspaceMember>();
  postOffices = new Map<string, PostOffice>();
  mailboxes = new Map<string, Mailbox>();
  mailEvents = new Map<string, MailEvent>();
  collectionEvents = new Map<string, CollectionEvent>();
  auditEvents = new Map<string, AuditEvent>();
  private mailAcknowledgements = new Map<string, { workspaceId: string; provider: string; messageId: string; acknowledged: boolean; nextAttemptAt: number }>();
  sessions = new Map<string, Session>();
  authChallenges = new Map<string, AuthChallenge>();
  recoveryCodes = new Map<string, { id: string; userId: string; codeHash: string; usedAt?: string }>();
  webAuthnChallenges = new Map<string, { id: string; userId?: string; type: "registration" | "authentication"; challenge: string; expiresAt: string; createdAt: string }>();
  passkeyCredentials = new Map<string, { id: string; userId: string; credentialId: string; publicKey: ReturnType<Uint8Array["slice"]>; counter: number; transports: string[]; friendlyName: string; lastUsedAt?: string }>();

  async seedDemo() {
    if (this.users.size > 0) return;
    const workspace: Workspace = { id: "ws_company", name: "pobox.watch Workspace" };
    this.workspaces.set(workspace.id, workspace);
    const demoUsers = [
      ["usr_daniel", "daniel@example.com", "Daniel", "ADMIN"],
      ["usr_sarah", "sarah@example.com", "Sarah", "MEMBER"],
      ["usr_john", "john@example.com", "John", "MEMBER"]
    ] as const;
    for (const [id, email, displayName, role] of demoUsers) {
      this.users.set(id, {
        id,
        email,
        displayName,
        passwordHash: await argon2.hash("Password123!"),
        emailVerified: true,
        active: true
      });
      this.members.set(`mem_${id}`, {
        id: `mem_${id}`,
        workspaceId: workspace.id,
        userId: id,
        role,
        status: "ACTIVE"
      });
    }

    const offices: PostOffice[] = [
      {
        id: "po_melbourne_gpo",
        workspaceId: workspace.id,
        name: "Melbourne GPO",
        address: "350 Bourke Street, Melbourne VIC",
        phone: "+61 13 13 18",
        latitude: -37.8136,
        longitude: 144.9631,
        geofenceRadius: 200,
        active: true
      },
      {
        id: "po_south_melbourne",
        workspaceId: workspace.id,
        name: "South Melbourne Post Office",
        address: "113-115 Clarendon Street, South Melbourne VIC",
        phone: "+61 13 13 18",
        latitude: -37.8327,
        longitude: 144.9604,
        geofenceRadius: 200,
        active: true
      },
      {
        id: "po_richmond",
        workspaceId: workspace.id,
        name: "Richmond Post Office",
        address: "382 Bridge Road, Richmond VIC",
        phone: "+61 13 13 18",
        latitude: -37.8186,
        longitude: 145.0018,
        geofenceRadius: 200,
        active: true
      }
    ];
    offices.forEach((office) => this.postOffices.set(office.id, { ...office, updatedAt: new Date().toISOString() }));

    const boxes = [
      ["box_1234", "po_melbourne_gpo", "PO Box 1234", "1234"],
      ["box_1235", "po_melbourne_gpo", "PO Box 1235", "1235"],
      ["box_1236", "po_melbourne_gpo", "PO Box 1236", "1236"],
      ["box_1237", "po_melbourne_gpo", "PO Box 1237", "1237"],
      ["box_882", "po_south_melbourne", "PO Box 882", "882"],
      ["box_5678", "po_south_melbourne", "PO Box 5678", "5678"],
      ["box_4412", "po_richmond", "PO Box 4412", "4412"],
      ["box_9921", "po_richmond", "PO Box 9921", "9921"]
    ] as const;
    for (const [id, postOfficeId, name, boxNumber] of boxes) {
      this.mailboxes.set(id, {
        id,
        workspaceId: workspace.id,
        postOfficeId,
        name,
        boxNumber,
        active: true,
        mailWaiting: false,
        parcelWaiting: false,
        updatedAt: new Date().toISOString()
      });
    }
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = [...this.users.values()].find((candidate) => candidate.email.toLowerCase() === email.toLowerCase());
    if (!user || !user.active || ![...this.members.values()].some(member => member.userId === user.id && member.status === "ACTIVE") || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedError("Invalid email or password.");
    }
    if (user.totpEnabled) {
      const challenge = {
        id: nanoid(32),
        userId: user.id,
        expiresAt: new Date(Date.now() + 1000 * 60 * 10).toISOString()
      };
      this.authChallenges.set(challenge.id, challenge);
      return { kind: "two_factor_required", challengeId: challenge.id, expiresAt: challenge.expiresAt, methods: ["totp", "recovery_code"] };
    }
    return { kind: "session", ...(await this.createSession(user)) };
  }

  async verifySecondFactor(challengeId: string, code: string): Promise<Session> {
    const challenge = this.authChallenges.get(challengeId);
    if (!challenge || new Date(challenge.expiresAt).getTime() < Date.now()) throw new UnauthorizedError("Two-factor challenge expired.");
    const user = this.users.get(challenge.userId);
    if (!user?.active || !user.totpEnabled || !user.totpSecretEncrypted) throw new UnauthorizedError("Two-factor authentication is not enabled.");
    const validTotp = verifyTotp(decryptSecret(user.totpSecretEncrypted), code);
    const recovery = [...this.recoveryCodes.values()].find(
      (candidate) => candidate.userId === user.id && !candidate.usedAt && recoveryCodeMatches(code, candidate.codeHash)
    );
    if (!validTotp && !recovery) throw new UnauthorizedError("Invalid two-factor code.");
    if (recovery) this.recoveryCodes.set(recovery.id, { ...recovery, usedAt: new Date().toISOString() });
    this.authChallenges.delete(challengeId);
    return this.createSession(user, true);
  }

  async createSessionForUser(userId: string): Promise<Session> {
    const user = this.users.get(userId);
    if (!user?.active) throw new UnauthorizedError("Missing user.");
    return this.createSession(user, true);
  }

  async securityStatus(session: Session): Promise<SecurityStatus> {
    const user = this.users.get(session.userId);
    if (!user) throw new UnauthorizedError("Missing user.");
    return {
      passkeysAvailable: this.passkeysAvailable(),
      passkeyCount: [...this.passkeyCredentials.values()].filter((credential) => credential.userId === user.id).length,
      totpEnabled: user.totpEnabled ?? false,
      recoveryCodesRemaining: [...this.recoveryCodes.values()].filter((code) => code.userId === user.id && !code.usedAt).length
    };
  }

  async beginTotpSetup(session: Session, proof?: string) {
    const user = this.users.get(session.userId);
    if (!user) throw new UnauthorizedError("Missing user.");
    if (user.totpEnabled) {
      const recovery = [...this.recoveryCodes.values()].find(candidate => candidate.userId === user.id && !candidate.usedAt && recoveryCodeMatches(proof ?? "", candidate.codeHash));
      if (!proof || (!recovery && !verifyTotp(decryptSecret(user.totpSecretEncrypted!), proof))) throw new UnauthorizedError("Enter a current authenticator or unused recovery code.");
      if (recovery) this.recoveryCodes.set(recovery.id, { ...recovery, usedAt: new Date().toISOString() });
    }
    const secret = generateTotpSecret();
    this.users.set(user.id, { ...user, totpPendingSecretEncrypted: encryptSecret(secret), totpPendingSessionId: session.id, totpPendingExpiresAt: new Date(Date.now() + 600000).toISOString() });
    return { secret, otpauthUrl: totpUri(secret, user.email) };
  }

  async confirmTotpSetup(session: Session, code: string): Promise<ConfirmTotpResult> {
    const user = this.users.get(session.userId);
    if (!user?.totpPendingSecretEncrypted) throw new ConflictError("Start 2FA setup before confirming.");
    if (user.totpPendingSessionId !== session.id || !user.totpPendingExpiresAt || new Date(user.totpPendingExpiresAt).getTime() <= Date.now()) throw new UnauthorizedError("Authenticator setup expired. Start again in this session.");
    const secret = decryptSecret(user.totpPendingSecretEncrypted);
    if (!verifyTotp(secret, code)) throw new UnauthorizedError("Invalid two-factor code.");
    const recoveryCodes = generateRecoveryCodes();
    for (const existing of [...this.recoveryCodes.values()].filter((candidate) => candidate.userId === user.id)) {
      this.recoveryCodes.delete(existing.id);
    }
    for (const recoveryCode of recoveryCodes) {
      const id = nanoid();
      this.recoveryCodes.set(id, { id, userId: user.id, codeHash: hashRecoveryCode(recoveryCode) });
    }
    this.users.set(user.id, {
      ...user,
      totpSecretEncrypted: user.totpPendingSecretEncrypted,
      totpPendingSecretEncrypted: undefined,
      totpPendingSessionId: undefined,
      totpPendingExpiresAt: undefined,
      totpEnabled: true,
      totpConfirmedAt: new Date().toISOString()
    });
    for (const existing of this.sessions.values()) {
      if (existing.userId === user.id && existing.id !== session.id) this.sessions.delete(existing.id);
    }
    this.sessions.set(session.id, { ...session, secondFactorVerified: true });
    for (const challenge of this.authChallenges.values()) {
      if (challenge.userId === user.id) this.authChallenges.delete(challenge.id);
    }
    return { recoveryCodes };
  }

  async disableTotp(session: Session, code: string): Promise<void> {
    const user = this.users.get(session.userId);
    if (!user?.totpEnabled || !user.totpSecretEncrypted) throw new ConflictError("2FA is not enabled.");
    if (!verifyTotp(decryptSecret(user.totpSecretEncrypted), code)) throw new UnauthorizedError("Invalid two-factor code.");
    this.users.set(user.id, { ...user, totpEnabled: false, totpSecretEncrypted: undefined, totpPendingSecretEncrypted: undefined, totpConfirmedAt: undefined });
    for (const recovery of [...this.recoveryCodes.values()].filter((candidate) => candidate.userId === user.id)) {
      this.recoveryCodes.delete(recovery.id);
    }
  }

  async beginPasskeyRegistration(session: Session): Promise<PasskeyRegistrationOptions> {
    const user = this.users.get(session.userId);
    if (!user) throw new UnauthorizedError("Missing user.");
    const config = webAuthnConfig();
    const existing = [...this.passkeyCredentials.values()].filter((credential) => credential.userId === user.id);
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: user.email,
      userID: Uint8Array.from(Buffer.from(user.id)),
      userDisplayName: user.displayName,
      attestationType: "none",
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as Array<"ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" }
    });
    const id = nanoid();
    this.webAuthnChallenges.set(id, { id, userId: user.id, type: "registration", challenge: options.challenge, expiresAt: new Date(Date.now() + 1000 * 60 * 10).toISOString(), createdAt: new Date().toISOString() });
    return { options };
  }

  async verifyPasskeyRegistration(session: Session, response: RegistrationResponseJSON, friendlyName?: string): Promise<SecurityStatus> {
    const responseChallenge = challengeFromClientData(response.response.clientDataJSON);
    const user = this.users.get(session.userId);
    const challenge = [...this.webAuthnChallenges.values()]
      .find((candidate) => candidate.userId === session.userId && candidate.type === "registration" && candidate.challenge === responseChallenge && new Date(candidate.expiresAt).getTime() > Date.now());
    if (!user || !challenge) throw new UnauthorizedError("Passkey registration expired.");
    const config = webAuthnConfig();
    const verification = await verifyRegistrationResponse({
      requireUserVerification: true,
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID
    });
    if (!verification.verified) throw new UnauthorizedError("Passkey registration could not be verified.");
    if (!this.webAuthnChallenges.delete(challenge.id) || new Date(challenge.expiresAt).getTime() <= Date.now()) throw new UnauthorizedError("Passkey registration expired or already used.");
    const credential = verification.registrationInfo.credential;
    this.passkeyCredentials.set(credential.id, {
      id: nanoid(),
      userId: user.id,
      credentialId: credential.id,
      publicKey: credential.publicKey.slice(),
      counter: credential.counter,
      transports: credential.transports ?? [],
      friendlyName: friendlyName?.trim() || "Passkey"
    });
    for (const existing of [...this.webAuthnChallenges.values()].filter((candidate) => candidate.userId === user.id && candidate.type === "registration")) {
      this.webAuthnChallenges.delete(existing.id);
    }
    return this.securityStatus(session);
  }

  async beginPasskeyAuthentication(email?: string): Promise<PasskeyAuthenticationOptions> {
    const user = email ? [...this.users.values()].find((candidate) => candidate.email.toLowerCase() === email.toLowerCase()) : undefined;
    const credentials = user ? [...this.passkeyCredentials.values()].filter((credential) => credential.userId === user.id) : undefined;
    const allowedCredentials = credentials?.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports as Array<"ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">
    }));
    const config = webAuthnConfig();
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: allowedCredentials && allowedCredentials.length > 0 ? allowedCredentials : undefined,
      userVerification: "required"
    });
    const id = nanoid();
    this.webAuthnChallenges.set(id, { id, userId: user?.id, type: "authentication", challenge: options.challenge, expiresAt: new Date(Date.now() + 1000 * 60 * 10).toISOString(), createdAt: new Date().toISOString() });
    return { options };
  }

  async verifyPasskeyAuthentication(response: AuthenticationResponseJSON): Promise<LoginResult> {
    const credential = this.passkeyCredentials.get(response.id);
    const user = credential ? this.users.get(credential.userId) : undefined;
    if (!credential || !user?.active) throw new UnauthorizedError("Passkey is not registered.");
    const responseChallenge = challengeFromClientData(response.response.clientDataJSON);
    const challenge = [...this.webAuthnChallenges.values()]
      .find((candidate) => candidate.type === "authentication" && candidate.challenge === responseChallenge && (!candidate.userId || candidate.userId === credential.userId) && new Date(candidate.expiresAt).getTime() > Date.now());
    if (!challenge) throw new UnauthorizedError("Passkey sign-in expired.");
    const config = webAuthnConfig();
    const verification = await verifyAuthenticationResponse({
      requireUserVerification: true,
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: {
        id: credential.credentialId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports as Array<"ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">
      }
    });
    if (!verification.verified) throw new UnauthorizedError("Passkey sign-in could not be verified.");
    if (!this.webAuthnChallenges.delete(challenge.id) || new Date(challenge.expiresAt).getTime() <= Date.now()) throw new UnauthorizedError("Passkey sign-in expired or already used.");
    this.passkeyCredentials.set(credential.credentialId, { ...credential, counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date().toISOString() });
    this.webAuthnChallenges.delete(challenge.id);
    if (user.totpEnabled) {
      const authChallenge = {
        id: nanoid(32),
        userId: user.id,
        expiresAt: new Date(Date.now() + 1000 * 60 * 10).toISOString()
      };
      this.authChallenges.set(authChallenge.id, authChallenge);
      return { kind: "two_factor_required", challengeId: authChallenge.id, expiresAt: authChallenge.expiresAt, methods: ["totp", "recovery_code"] };
    }
    return { kind: "session", ...(await this.createSession(user)) };
  }

  private async createSession(user: User, secondFactorVerified = false): Promise<Session> {
    const previousLoginAt = user.lastLoginAt;
    const now = new Date().toISOString();
    const session: Session = {
      id: nanoid(32),
      secondFactorVerified,
      userId: user.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(),
      previousLoginAt
    };
    this.users.set(user.id, { ...user, lastLoginAt: now });
    this.sessions.set(session.id, session);
    return session;
  }

  private passkeysAvailable() {
    try {
      const config = webAuthnConfig();
      return Boolean(config.rpID && config.origin);
    } catch {
      return false;
    }
  }

  async getSession(sessionId?: string): Promise<Session> {
    if (!sessionId) throw new UnauthorizedError("Missing session.");
    const session = this.sessions.get(sessionId);
    if (!session || new Date(session.expiresAt).getTime() <= Date.now() || !this.users.get(session.userId)?.active) {
      throw new UnauthorizedError("Session expired.");
    }
    if (this.users.get(session.userId)?.totpEnabled && !session.secondFactorVerified) throw new UnauthorizedError("Please sign in again with two-factor authentication.");
    return session;
  }

  async revokeSession(sessionId?: string): Promise<void> {
    if (sessionId) this.sessions.delete(sessionId);
  }

  async requireMember(session: Session, workspaceId: string, role?: "ADMIN"): Promise<WorkspaceMember> {
    if (!this.users.get(session.userId)?.active) throw new ForbiddenError("Workspace access denied.");
    const member = [...this.members.values()].find(
      (candidate) =>
        candidate.userId === session.userId &&
        candidate.workspaceId === workspaceId &&
        candidate.status === "ACTIVE"
    );
    if (!member) throw new ForbiddenError("Workspace access denied.");
    if (role && member.role !== role) throw new ForbiddenError("Admin role required.");
    return member;
  }

  async dashboard(session: Session, workspaceId: string): Promise<DashboardSnapshot> {
    const member = await this.requireMember(session, workspaceId);
    const user = this.users.get(session.userId);
    const workspace = this.workspaces.get(workspaceId);
    if (!user || !workspace) throw new NotFoundError("Workspace not found.");
    const postOffices = [...this.postOffices.values()]
      .filter((office) => office.workspaceId === workspaceId && office.active)
      .map((office) => ({
        ...office,
        mailboxes: [...this.mailboxes.values()].filter((box) => box.postOfficeId === office.id && box.active)
      }));
    const history = [
      ...[...this.mailEvents.values()].filter((event) => event.workspaceId === workspaceId),
      ...[...this.collectionEvents.values()].filter((event) => event.workspaceId === workspaceId)
    ].sort((a, b) => {
      const left = "processedAt" in a ? a.processedAt : a.collectedAt;
      const right = "processedAt" in b ? b.processedAt : b.collectedAt;
      return right.localeCompare(left);
    });
    return {
      workspace,
      currentUser: { id: user.id, email: user.email, displayName: user.displayName, role: member.role },
      outstandingMailboxCount: await this.outstandingMailboxCount(workspaceId),
      postOffices,
      history
    };
  }

  async outstandingMailboxCount(workspaceId: string): Promise<number> {
    return [...this.mailboxes.values()].filter((box) => box.workspaceId === workspaceId && box.active && (box.mailWaiting || box.parcelWaiting)).length;
  }

  async processIncomingMail(input: IncomingProviderMessage): Promise<IncomingMailResult> {
    const result = await this.processMail(input);
    if (result.kind !== "needs_review") this.queueMailAcknowledgement(input.workspaceId, input.provider, input.providerMessageId);
    return result;
  }

  private queueMailAcknowledgement(workspaceId: string, provider: string, messageId: string) {
    const key = JSON.stringify([workspaceId, provider, messageId]);
    const existing = this.mailAcknowledgements.get(key);
    if (!existing || existing.acknowledged) this.mailAcknowledgements.set(key, { workspaceId, provider, messageId, acknowledged: false, nextAttemptAt: Date.now() });
  }

  async pendingMailAcknowledgements(workspaceId: string, provider: string) {
    return [...this.mailAcknowledgements.values()].filter((item) => item.workspaceId === workspaceId && item.provider === provider && !item.acknowledged && item.nextAttemptAt <= Date.now())
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt).slice(0, 100).map((item) => item.messageId);
  }

  async acknowledgeMail(workspaceId: string, provider: string, messageId: string) {
    const item = this.mailAcknowledgements.get(JSON.stringify([workspaceId, provider, messageId]));
    if (item) item.acknowledged = true;
  }

  async failMailAcknowledgement(workspaceId: string, provider: string, messageId: string, _reason: string) {
    const item = this.mailAcknowledgements.get(JSON.stringify([workspaceId, provider, messageId]));
    if (item && !item.acknowledged) item.nextAttemptAt = Date.now() + 60000;
  }

  private async processMail(input: IncomingProviderMessage): Promise<IncomingMailResult> {
    const duplicateKey = `${input.provider}:${input.providerMessageId}`;
    const duplicate = [...this.mailEvents.values()].find(
      (event) => `${event.provider}:${event.providerMessageId}` === duplicateKey && event.workspaceId === input.workspaceId
    );
    if (duplicate) return { kind: "duplicate", mailboxId: duplicate.mailboxId, notificationType: duplicate.notificationType };

    const reviewEvents = [...this.auditEvents.values()].filter((event) => reviewMatchesProviderMessage(event, input));
    const existingReview = reviewEvents.find((event) => event.eventType === "mail.needs_review");
    if (existingReview) {
      const notificationType = notificationTypeFromMetadata(existingReview.metadata, "MAIL");
      return reviewEvents.some((event) => isReviewResolutionEvent(event.eventType))
        ? { kind: "duplicate", notificationType }
        : { kind: "needs_review", notificationType };
    }

    const workspaceBoxes = [...this.mailboxes.values()].filter((box) => box.workspaceId === input.workspaceId);
    const workspacePostOffices = [...this.postOffices.values()].filter((office) => office.workspaceId === input.workspaceId);
    const parsed = parseMailNotification(input, workspaceBoxes, workspacePostOffices);
    if (!parsed.mailboxId || parsed.requiresReview) {
      this.audit("system", input.workspaceId, "mail.needs_review", "mail_message", input.providerMessageId, {
        provider: input.provider,
        providerThreadId: input.providerThreadId,
        sender: input.sender,
        subject: input.subject,
        bodyPreview: input.bodyPreview,
        receivedAt: input.receivedAt,
        mailboxNumber: parsed.mailboxNumber,
        postOfficeName: parsed.postOfficeName,
        notificationType: parsed.notificationType,
        confidence: parsed.confidence,
        reason: reviewReason(parsed)
      });
      return { kind: "needs_review", notificationType: parsed.notificationType };
    }

    const now = new Date().toISOString();
    const receivedAt = input.receivedAt ?? now;
    const event: MailEvent = {
      id: nanoid(),
      workspaceId: input.workspaceId,
      mailboxId: parsed.mailboxId,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      sender: input.sender,
      subject: input.subject,
      notificationType: parsed.notificationType,
      receivedAt,
      parserConfidence: parsed.confidence,
      parserRuleId: parsed.ruleId,
      processedAt: now
    };
    this.mailEvents.set(event.id, event);
    const mailbox = this.mailboxes.get(parsed.mailboxId);
    if (!mailbox) throw new NotFoundError("PO box not found.");
    this.mailboxes.set(mailbox.id, {
      ...mailbox,
      mailWaiting: parsed.notificationType === "MAIL" ? true : mailbox.mailWaiting,
      parcelWaiting: parsed.notificationType === "PARCEL" ? true : mailbox.parcelWaiting,
      latestNotificationAt: parsed.notificationType === "MAIL" ? receivedAt : mailbox.latestNotificationAt,
      latestParcelNotificationAt: parsed.notificationType === "PARCEL" ? receivedAt : mailbox.latestParcelNotificationAt,
      updatedAt: now
    });
    this.audit("system", input.workspaceId, parsed.notificationType === "PARCEL" ? "parcel.detected" : "mail.detected", "mailbox", mailbox.id, {
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      notificationType: parsed.notificationType
    });
    return { kind: "processed", mailboxId: mailbox.id, notificationType: parsed.notificationType };
  }

  async collectMailbox(session: Session, workspaceId: string, mailboxId: string, source: CollectionSource, expectedUpdatedAt?: string): Promise<CollectionEvent> {
    await this.requireMember(session, workspaceId);
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox || mailbox.workspaceId !== workspaceId || !mailbox.active) throw new NotFoundError("PO box not found.");
    if (expectedUpdatedAt && expectedUpdatedAt !== mailbox.updatedAt) throw new ConflictError("This PO box changed. Refresh before collecting.");
    if (!mailbox.mailWaiting && !mailbox.parcelWaiting) {
      const existing = [...this.collectionEvents.values()]
        .filter((event) => event.mailboxId === mailboxId)
        .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
      throw new ConflictError(
        existing ? `Already collected at ${existing.collectedAt} by ${existing.collectedBy}.` : "PO box is already clear."
      );
    }
    const now = new Date().toISOString();
    const event: CollectionEvent = {
      id: nanoid(),
      workspaceId,
      mailboxId,
      collectedBy: session.userId,
      collectedAt: now,
      source,
      method: "explicit_confirmation"
    };
    this.collectionEvents.set(event.id, event);
    this.mailboxes.set(mailbox.id, {
      ...mailbox,
      mailWaiting: false,
      parcelWaiting: false,
      lastCollectedAt: now,
      lastCollectedBy: session.userId,
      updatedAt: now
    });
    this.audit(session.userId, workspaceId, "mailbox.collected", "mailbox", mailbox.id, { source });
    return event;
  }

  async listMembers(session: Session, workspaceId: string): Promise<TeamMemberSummary[]> {
    await this.requireMember(session, workspaceId);
    return [...this.members.values()]
      .filter((member) => member.workspaceId === workspaceId)
      .map((member) => {
        const user = this.users.get(member.userId);
        if (!user) throw new NotFoundError("User not found.");
        return {
          id: user.id,
          version: member.version ?? member.id,
          email: user.email,
          displayName: user.displayName,
          role: member.role,
          status: member.status,
          active: user.active && member.status === "ACTIVE"
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private activeAdminCount(workspaceId: string): number {
    return [...this.members.values()].filter((candidate) => {
      const user = this.users.get(candidate.userId);
      return candidate.workspaceId === workspaceId && candidate.role === "ADMIN" && candidate.status === "ACTIVE" && user?.active;
    }).length;
  }

  private assertUserManagementChangeIsSafe(session: Session, workspaceId: string, userId: string, member: WorkspaceMember, nextRole: WorkspaceMember["role"], nextStatus: WorkspaceMember["status"]) {
    if (session.userId === userId && nextRole !== member.role) {
      throw new ConflictError("You cannot change your own role.");
    }
    if (session.userId === userId && nextStatus !== member.status) {
      throw new ConflictError("You cannot change your own access status.");
    }
    if (member.role === "ADMIN" && member.status === "ACTIVE" && (nextRole !== "ADMIN" || nextStatus !== "ACTIVE") && this.activeAdminCount(workspaceId) <= 1) {
      throw new ConflictError("At least one active admin is required.");
    }
  }

  async listReviewItems(session: Session, workspaceId: string): Promise<ReviewItem[]> {
    await this.requireMember(session, workspaceId);
    const resolvedProviderMessages = new Set(
      [...this.auditEvents.values()]
        .filter((event) => event.workspaceId === workspaceId && (event.eventType === "mail.review_resolved" || event.eventType === "mail.review_ignored" || event.eventType === "mail.review_dismissed"))
        .map((event) => JSON.stringify([event.metadata.provider ?? "review", event.entityId]))
    );
    return [...this.auditEvents.values()]
      .filter((event) => event.workspaceId === workspaceId && event.eventType === "mail.needs_review" && !resolvedProviderMessages.has(JSON.stringify([event.metadata.provider ?? "review", event.entityId])))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((event) => ({
        id: event.id,
        providerMessageId: event.entityId,
        provider: typeof event.metadata.provider === "string" ? event.metadata.provider : undefined,
        sender: typeof event.metadata.sender === "string" ? event.metadata.sender : undefined,
        subject: typeof event.metadata.subject === "string" ? event.metadata.subject : undefined,
        bodyPreview: typeof event.metadata.bodyPreview === "string" ? mailText(event.metadata.bodyPreview) : undefined,
        mailboxNumber: typeof event.metadata.mailboxNumber === "string" ? event.metadata.mailboxNumber : undefined,
        postOfficeName: typeof event.metadata.postOfficeName === "string" ? event.metadata.postOfficeName : undefined,
        notificationType: event.metadata.notificationType === "PARCEL" ? "PARCEL" : "MAIL",
        confidence: typeof event.metadata.confidence === "number" ? event.metadata.confidence : undefined,
        reason: typeof event.metadata.reason === "string" ? event.metadata.reason : reviewReasonFromMetadata(event.metadata),
        receivedAt: typeof event.metadata.receivedAt === "string" ? event.metadata.receivedAt : undefined,
        createdAt: event.createdAt
      }));
  }

  async resolveReviewItem(session: Session, workspaceId: string, reviewItemId: string, mailboxId: string, newMailbox?: { postOfficeId: string; boxNumber: string }): Promise<IncomingMailResult> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const review = this.auditEvents.get(reviewItemId);
    if (!review || review.workspaceId !== workspaceId || review.eventType !== "mail.needs_review") throw new NotFoundError("Review item not found.");
    if (newMailbox) {
      const prior = [...this.auditEvents.values()].find((event) => event.workspaceId === workspaceId && event.metadata.reviewItemId === reviewItemId && event.metadata.postOfficeId === newMailbox.postOfficeId && event.metadata.boxNumber === normalizeMailboxNumber(newMailbox.boxNumber));
      mailboxId = typeof prior?.metadata.mailboxId === "string" ? prior.metadata.mailboxId : "";
    }
    if (this.reviewAlreadyHandled(review, "mail.review_resolved", mailboxId)) return { kind: "duplicate", mailboxId };
    if (newMailbox) {
      const boxNumber = normalizeMailboxNumber(newMailbox.boxNumber);
      if (!boxNumber) throw new ConflictError("Enter a PO box number.");
      mailboxId = this.createMailboxRecord(session, workspaceId, { ...newMailbox, boxNumber }).id;
    }
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox || mailbox.workspaceId !== workspaceId || !mailbox.active) throw new NotFoundError("PO box not found.");

    const duplicate = [...this.mailEvents.values()].find(
      (event) => event.workspaceId === workspaceId && event.provider === (review.metadata.provider ?? "review") && event.providerMessageId === review.entityId
    );
    if (!duplicate) {
      const now = new Date().toISOString();
      const mailEvent: MailEvent = {
        id: nanoid(),
        workspaceId,
        mailboxId,
        provider: typeof review.metadata.provider === "string" ? review.metadata.provider : "review",
        providerMessageId: review.entityId,
        sender: typeof review.metadata.sender === "string" ? review.metadata.sender : "review",
        subject: typeof review.metadata.subject === "string" ? review.metadata.subject : "Reviewed mail notification",
        notificationType: review.metadata.notificationType === "PARCEL" ? "PARCEL" : "MAIL",
        receivedAt: typeof review.metadata.receivedAt === "string" ? review.metadata.receivedAt : review.createdAt,
        parserConfidence: typeof review.metadata.confidence === "number" ? review.metadata.confidence : 1,
        parserRuleId: "manual-review",
        processedAt: now
      };
      this.mailEvents.set(mailEvent.id, mailEvent);
      this.mailboxes.set(mailbox.id, {
        ...mailbox,
        mailWaiting: mailEvent.notificationType === "MAIL" ? true : mailbox.mailWaiting,
        parcelWaiting: mailEvent.notificationType === "PARCEL" ? true : mailbox.parcelWaiting,
        latestNotificationAt: mailEvent.notificationType === "MAIL" ? mailEvent.receivedAt : mailbox.latestNotificationAt,
        latestParcelNotificationAt: mailEvent.notificationType === "PARCEL" ? mailEvent.receivedAt : mailbox.latestParcelNotificationAt,
        updatedAt: now
      });
    }

    this.audit(session.userId, workspaceId, "mail.review_resolved", "mail_message", review.entityId, {
      reviewItemId,
      mailboxId,
      postOfficeId: newMailbox?.postOfficeId,
      boxNumber: newMailbox ? normalizeMailboxNumber(newMailbox.boxNumber) : undefined,
      provider: review.metadata.provider,
      providerThreadId: review.metadata.providerThreadId
    });
    this.queueMailAcknowledgement(workspaceId, String(review.metadata.provider ?? "review"), review.entityId);
    return { kind: duplicate ? "duplicate" : "processed", mailboxId, notificationType: review.metadata.notificationType === "PARCEL" ? "PARCEL" : "MAIL" };
  }

  async markReviewItemResolved(session: Session, workspaceId: string, reviewItemId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const review = this.auditEvents.get(reviewItemId);
    if (!review || review.workspaceId !== workspaceId || review.eventType !== "mail.needs_review") throw new NotFoundError("Review item not found.");
    if (this.reviewAlreadyHandled(review, "mail.review_resolved")) return;
    this.audit(session.userId, workspaceId, "mail.review_resolved", "mail_message", review.entityId, {
      reviewItemId,
      action: "resolved_without_box_change",
      provider: review.metadata.provider,
      providerThreadId: review.metadata.providerThreadId
    });
    this.queueMailAcknowledgement(workspaceId, String(review.metadata.provider ?? "review"), review.entityId);
  }

  async dismissReviewItem(session: Session, workspaceId: string, reviewItemId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const review = this.auditEvents.get(reviewItemId);
    if (!review || review.workspaceId !== workspaceId || review.eventType !== "mail.needs_review") throw new NotFoundError("Review item not found.");
    if (this.reviewAlreadyHandled(review, "mail.review_ignored")) return;
    this.audit(session.userId, workspaceId, "mail.review_ignored", "mail_message", review.entityId, {
      reviewItemId,
      action: "ignored",
      provider: review.metadata.provider,
      providerThreadId: review.metadata.providerThreadId
    });
    this.queueMailAcknowledgement(workspaceId, String(review.metadata.provider ?? "review"), review.entityId);
  }

  private reviewAlreadyHandled(review: AuditEvent, eventType: string, mailboxId?: string) {
    const prior = [...this.auditEvents.values()].find((event) => isReviewResolutionEvent(event.eventType)
      && event.workspaceId === review.workspaceId && event.entityId === review.entityId
      && event.metadata.provider === review.metadata.provider);
    if (!prior) return false;
    if (prior.eventType !== eventType || prior.metadata.mailboxId !== mailboxId) throw new ConflictError("This review item was already handled.");
    this.queueMailAcknowledgement(review.workspaceId, String(review.metadata.provider ?? "review"), review.entityId);
    return true;
  }

  async searchPostOfficeLocations(session: Session, workspaceId: string, query: string): Promise<LctrPostOfficeLocation[]> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return searchLctrPostOffices(query);
  }

  async postOfficeDirectoryStatus(session: Session, workspaceId: string): Promise<PostOfficeDirectoryStatus> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return { status: "live_lookup", rowCount: 0, activeRowCount: 0, message: "In-memory mode uses live LCTR lookup." };
  }

  async syncPostOfficeDirectory(session: Session, workspaceId: string): Promise<PostOfficeDirectoryStatus> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return this.postOfficeDirectoryStatus(session, workspaceId);
  }

  async appChanges(session: Session, workspaceId: string): Promise<AppChangesResult> {
    const member = await this.requireMember(session, workspaceId);
    const user = this.users.get(session.userId);
    if (!user) throw new UnauthorizedError("Missing user.");
    return {
      version: appVersion,
      lastSeenVersion: user.lastSeenReleaseVersion,
      changes: changesAfterVersion(user.lastSeenReleaseVersion, member.role)
    };
  }

  async markAppChangesSeen(session: Session, workspaceId: string, version: string): Promise<AppChangesResult> {
    await this.requireMember(session, workspaceId);
    const user = this.users.get(session.userId);
    if (!user) throw new UnauthorizedError("Missing user.");
    this.users.set(user.id, {
      ...user,
      lastSeenReleaseVersion: version,
      lastSeenReleaseAt: new Date().toISOString()
    });
    return this.appChanges(session, workspaceId);
  }

  async createUser(session: Session, workspaceId: string, input: CreateUserInput): Promise<TeamMemberSummary> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const email = input.email.toLowerCase();
    if ([...this.users.values()].some((user) => user.email.toLowerCase() === email)) {
      throw new ConflictError("User email already exists.");
    }
    const user: User = {
      id: nanoid(),
      email,
      displayName: input.displayName,
      passwordHash: await argon2.hash(input.password),
      emailVerified: true,
      active: true
    };
    this.users.set(user.id, user);
    this.members.set(`mem_${user.id}`, {
      id: `mem_${user.id}`,
      workspaceId,
      userId: user.id,
      role: input.role,
      status: "ACTIVE"
    });
    this.audit(session.userId, workspaceId, "member.created", "user", user.id, { email, role: input.role });
    return { id: user.id, email: user.email, displayName: user.displayName, role: input.role, status: "ACTIVE", active: true };
  }

  async updateUser(session: Session, workspaceId: string, userId: string, input: UpdateUserInput): Promise<TeamMemberSummary> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const member = [...this.members.values()].find((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId);
    const user = this.users.get(userId);
    if (!member || !user) throw new NotFoundError("User not found.");
    if (input.expectedVersion && input.expectedVersion !== (member.version ?? member.id)) throw new ConflictError("This user's access changed. Cancel editing and reload before saving.");
    const nextRole = input.role ?? member.role;
    const nextStatus = input.status ?? member.status;
    this.assertUserManagementChangeIsSafe(session, workspaceId, userId, member, nextRole, nextStatus);
    const email = input.email?.toLowerCase();
    if (((email && email !== user.email) || (input.displayName && input.displayName !== user.displayName)) && [...this.members.values()].some(candidate => candidate.userId === userId && candidate.workspaceId !== workspaceId)) throw new ForbiddenError("Shared account identity must be managed outside this workspace.");
    if (email && [...this.users.values()].some((candidate) => candidate.id !== userId && candidate.email.toLowerCase() === email)) {
      throw new ConflictError("User email already exists.");
    }
    const updatedUser = {
      ...user,
      email: email ?? user.email,
      displayName: input.displayName ?? user.displayName,
      active: user.active
    };
    const updatedMember = {
      ...member,
      version: nanoid(),
      role: nextRole,
      status: nextStatus
    };
    this.users.set(userId, updatedUser);
    this.members.set(member.id, updatedMember);
    this.audit(session.userId, workspaceId, "member.updated", "user", userId, {
      email,
      displayName: input.displayName,
      role: input.role,
      status: input.status
    });
    return {
      id: updatedUser.id,
      version: updatedMember.version,
      email: updatedUser.email,
      displayName: updatedUser.displayName,
      role: updatedMember.role,
      status: updatedMember.status,
      active: updatedUser.active && updatedMember.status === "ACTIVE"
    };
  }

  async deleteUser(session: Session, workspaceId: string, userId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    if (session.userId === userId) throw new ConflictError("You cannot delete your own user.");
    const member = [...this.members.values()].find((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId);
    const user = this.users.get(userId);
    if (!member || !user) throw new NotFoundError("User not found.");
    this.assertUserManagementChangeIsSafe(session, workspaceId, userId, member, member.role, "DISABLED");
    this.members.set(member.id, { ...member, version: nanoid(), status: "DISABLED" });
    this.audit(session.userId, workspaceId, "member.deleted", "user", userId, {});
  }

  async createPostOffice(session: Session, workspaceId: string, input: CreatePostOfficeInput): Promise<PostOffice> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office: PostOffice = {
      updatedAt: new Date().toISOString(),
      id: nanoid(),
      workspaceId,
      name: input.name,
      address: input.address,
      phone: input.phone,
      latitude: input.latitude,
      longitude: input.longitude,
      geofenceRadius: input.geofenceRadius,
      active: true
    };
    this.postOffices.set(office.id, office);
    this.audit(session.userId, workspaceId, "post_office.created", "post_office", office.id, { name: office.name });
    return office;
  }

  async updatePostOffice(session: Session, workspaceId: string, postOfficeId: string, input: UpdatePostOfficeInput): Promise<PostOffice> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office = this.postOffices.get(postOfficeId);
    if (!office || office.workspaceId !== workspaceId || !office.active) throw new NotFoundError("Post office not found.");
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== office.updatedAt) throw new ConflictError("This post office changed. Cancel editing and reload before saving.");
    const updated = {
      ...office,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(office.updatedAt ?? "") + 1 || 0)).toISOString(),
      name: input.name ?? office.name,
      address: input.address ?? office.address,
      phone: input.phone ?? office.phone,
      latitude: input.latitude ?? office.latitude,
      longitude: input.longitude ?? office.longitude,
      geofenceRadius: input.geofenceRadius ?? office.geofenceRadius
    };
    this.postOffices.set(postOfficeId, updated);
    this.audit(session.userId, workspaceId, "post_office.updated", "post_office", postOfficeId, { name: updated.name });
    return updated;
  }

  async deletePostOffice(session: Session, workspaceId: string, postOfficeId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office = this.postOffices.get(postOfficeId);
    if (!office || office.workspaceId !== workspaceId || !office.active) throw new NotFoundError("Post office not found.");
    this.postOffices.set(postOfficeId, { ...office, active: false });
    for (const mailbox of [...this.mailboxes.values()].filter((box) => box.workspaceId === workspaceId && box.postOfficeId === postOfficeId)) {
      this.mailboxes.set(mailbox.id, { ...mailbox, active: false });
    }
    this.audit(session.userId, workspaceId, "post_office.deleted", "post_office", postOfficeId, { name: office.name });
  }

  async createMailbox(session: Session, workspaceId: string, input: CreateMailboxInput): Promise<Mailbox> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return this.createMailboxRecord(session, workspaceId, input);
  }

  private createMailboxRecord(session: Session, workspaceId: string, input: CreateMailboxInput): Mailbox {
    const office = this.postOffices.get(input.postOfficeId);
    if (!office || office.workspaceId !== workspaceId || !office.active) throw new NotFoundError("Post office not found.");
    const boxNumber = normalizeMailboxNumber(input.boxNumber);
    if (!boxNumber) throw new ConflictError("Enter a PO box number.");
    if ([...this.mailboxes.values()].some((mailbox) =>
      mailbox.workspaceId === workspaceId &&
      mailbox.postOfficeId === input.postOfficeId &&
      normalizeMailboxNumber(mailbox.boxNumber) === normalizeMailboxNumber(boxNumber)
    )) {
      throw new ConflictError("This post office already has that PO box number.");
    }
    const now = new Date().toISOString();
    const name = input.name?.trim() || `PO Box ${boxNumber}`;
    const mailbox: Mailbox = {
      id: nanoid(),
      workspaceId,
      postOfficeId: input.postOfficeId,
      name,
      boxNumber,
      active: true,
      mailWaiting: false,
      parcelWaiting: false,
      updatedAt: now
    };
    this.mailboxes.set(mailbox.id, mailbox);
    this.audit(session.userId, workspaceId, "mailbox.created", "mailbox", mailbox.id, { boxNumber: mailbox.boxNumber });
    return mailbox;
  }

  async updateMailbox(session: Session, workspaceId: string, mailboxId: string, input: UpdateMailboxInput): Promise<Mailbox> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox || mailbox.workspaceId !== workspaceId || !mailbox.active) throw new NotFoundError("PO box not found.");
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== mailbox.updatedAt) throw new ConflictError("This PO box changed. Cancel editing and reload before saving.");
    if (input.postOfficeId) {
      const office = this.postOffices.get(input.postOfficeId);
      if (!office || office.workspaceId !== workspaceId || !office.active) throw new NotFoundError("Post office not found.");
    }
    const nextPostOfficeId = input.postOfficeId ?? mailbox.postOfficeId;
    const boxNumber = normalizeMailboxNumber(input.boxNumber ?? mailbox.boxNumber);
    if (!boxNumber) throw new ConflictError("Enter a PO box number.");
    if (boxNumber && [...this.mailboxes.values()].some((box) =>
      box.id !== mailboxId &&
      box.workspaceId === workspaceId &&
      box.postOfficeId === nextPostOfficeId &&
      normalizeMailboxNumber(box.boxNumber) === normalizeMailboxNumber(boxNumber)
    )) {
      throw new ConflictError("This post office already has that PO box number.");
    }
    const updated = {
      ...mailbox,
      postOfficeId: nextPostOfficeId,
      boxNumber: boxNumber ?? mailbox.boxNumber,
      name: boxNumber ? `PO Box ${boxNumber}` : mailbox.name,
      updatedAt: new Date().toISOString()
    };
    this.mailboxes.set(mailboxId, updated);
    this.audit(session.userId, workspaceId, "mailbox.updated", "mailbox", mailboxId, { boxNumber: updated.boxNumber });
    return updated;
  }

  async deleteMailbox(session: Session, workspaceId: string, mailboxId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox || mailbox.workspaceId !== workspaceId || !mailbox.active) throw new NotFoundError("PO box not found.");
    this.mailboxes.set(mailboxId, { ...mailbox, active: false, updatedAt: new Date().toISOString() });
    this.audit(session.userId, workspaceId, "mailbox.deleted", "mailbox", mailboxId, { boxNumber: mailbox.boxNumber });
  }

  async inviteMember(session: Session, workspaceId: string, email: string, role: "ADMIN" | "MEMBER") {
    await this.requireMember(session, workspaceId, "ADMIN");
    const event = this.audit(session.userId, workspaceId, "member.invited", "workspace", workspaceId, { email, role });
    return { invitationId: event.id, email, role, status: "PENDING_EMAIL_DELIVERY" };
  }

  private audit(actorUserId: string | undefined, workspaceId: string, eventType: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
    const event: AuditEvent = {
      id: nanoid(),
      workspaceId,
      actorUserId,
      eventType,
      entityType,
      entityId,
      metadata,
      createdAt: new Date().toISOString()
    };
    this.auditEvents.set(event.id, event);
    return event;
  }
}

function normalizeMailboxNumber(value: string) {
  return value.replace(/^\s*(?:p\.?\s*o\.?\s*box|pobox|post\s*box|postbox|box)\s*/i, "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function reviewReason(parsed: {
  mailboxNumber?: string;
  postOfficeName?: string;
  notificationType: "MAIL" | "PARCEL";
  confidence: number;
}) {
  if (parsed.notificationType === "PARCEL" && parsed.postOfficeName && !parsed.mailboxNumber) {
    return `Parcel notice matched ${parsed.postOfficeName}, but a single PO box could not be chosen automatically.`;
  }
  if (!parsed.mailboxNumber) {
    return "No PO box number could be read from the email.";
  }
  if (parsed.confidence >= 0.7) {
    return `PO Box ${parsed.mailboxNumber} matched more than one saved post office, so it needs a human choice.`;
  }
  return `PO Box ${parsed.mailboxNumber} is not saved yet.`;
}

function reviewReasonFromMetadata(metadata: Record<string, unknown>) {
  return reviewReason({
    mailboxNumber: typeof metadata.mailboxNumber === "string" ? metadata.mailboxNumber : undefined,
    postOfficeName: typeof metadata.postOfficeName === "string" ? metadata.postOfficeName : undefined,
    notificationType: metadata.notificationType === "PARCEL" ? "PARCEL" : "MAIL",
    confidence: typeof metadata.confidence === "number" ? metadata.confidence : 0
  });
}

function isReviewResolutionEvent(eventType: string) {
  return eventType === "mail.review_resolved" || eventType === "mail.review_ignored" || eventType === "mail.review_dismissed";
}

function reviewMatchesProviderMessage(event: AuditEvent, input: IncomingProviderMessage) {
  if (event.workspaceId !== input.workspaceId) return false;
  const metadata = event.metadata;
  if (typeof metadata.provider === "string" && metadata.provider !== input.provider) return false;
  return event.entityId === input.providerMessageId;
}

function notificationTypeFromMetadata(metadata: Record<string, unknown>, fallback: "MAIL" | "PARCEL") {
  return metadata.notificationType === "PARCEL" ? "PARCEL" : metadata.notificationType === "MAIL" ? "MAIL" : fallback;
}
