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
import type { PostOfficeDirectoryStatus } from "../lctr/postOfficeDirectory.js";
import { searchLctrPostOffices, type LctrPostOfficeLocation } from "../lctr/postOfficeLookup.js";
import type {
  AppStore,
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
  TeamMemberSummary
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
    offices.forEach((office) => this.postOffices.set(office.id, office));

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
        updatedAt: new Date().toISOString()
      });
    }
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = [...this.users.values()].find((candidate) => candidate.email.toLowerCase() === email.toLowerCase());
    if (!user || !user.active || !(await argon2.verify(user.passwordHash, password))) {
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
    if (!user?.totpEnabled || !user.totpSecretEncrypted) throw new UnauthorizedError("Two-factor authentication is not enabled.");
    const validTotp = verifyTotp(decryptSecret(user.totpSecretEncrypted), code);
    const recovery = [...this.recoveryCodes.values()].find(
      (candidate) => candidate.userId === user.id && !candidate.usedAt && recoveryCodeMatches(code, candidate.codeHash)
    );
    if (!validTotp && !recovery) throw new UnauthorizedError("Invalid two-factor code.");
    if (recovery) this.recoveryCodes.set(recovery.id, { ...recovery, usedAt: new Date().toISOString() });
    this.authChallenges.delete(challengeId);
    return this.createSession(user);
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

  async beginTotpSetup(session: Session) {
    const user = this.users.get(session.userId);
    if (!user) throw new UnauthorizedError("Missing user.");
    const secret = generateTotpSecret();
    this.users.set(user.id, { ...user, totpPendingSecretEncrypted: encryptSecret(secret) });
    return { secret, otpauthUrl: totpUri(secret, user.email) };
  }

  async confirmTotpSetup(session: Session, code: string): Promise<ConfirmTotpResult> {
    const user = this.users.get(session.userId);
    if (!user?.totpPendingSecretEncrypted) throw new ConflictError("Start 2FA setup before confirming.");
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
      totpEnabled: true,
      totpConfirmedAt: new Date().toISOString()
    });
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
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID
    });
    if (!verification.verified) throw new UnauthorizedError("Passkey registration could not be verified.");
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

  private async createSession(user: User): Promise<Session> {
    const previousLoginAt = user.lastLoginAt;
    const now = new Date().toISOString();
    const session: Session = {
      id: nanoid(32),
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
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
      throw new UnauthorizedError("Session expired.");
    }
    return session;
  }

  async requireMember(session: Session, workspaceId: string, role?: "ADMIN"): Promise<WorkspaceMember> {
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
      .filter((office) => office.workspaceId === workspaceId)
      .map((office) => ({
        ...office,
        mailboxes: [...this.mailboxes.values()].filter((box) => box.postOfficeId === office.id)
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
    return [...this.mailboxes.values()].filter((box) => box.workspaceId === workspaceId && box.active && box.mailWaiting).length;
  }

  async processIncomingMail(input: IncomingProviderMessage): Promise<IncomingMailResult> {
    const duplicateKey = `${input.provider}:${input.providerMessageId}`;
    const duplicate = [...this.mailEvents.values()].find(
      (event) => `${event.provider}:${event.providerMessageId}` === duplicateKey && event.workspaceId === input.workspaceId
    );
    if (duplicate) return { kind: "duplicate", mailboxId: duplicate.mailboxId };

    const workspaceBoxes = [...this.mailboxes.values()].filter((box) => box.workspaceId === input.workspaceId);
    const parsed = parseMailNotification(input, workspaceBoxes);
    if (!parsed.mailboxId || parsed.requiresReview) {
      this.audit("system", input.workspaceId, "mail.needs_review", "mail_message", input.providerMessageId, {
        subject: input.subject,
        mailboxNumber: parsed.mailboxNumber,
        confidence: parsed.confidence
      });
      return { kind: "needs_review" };
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
      mailWaiting: true,
      latestNotificationAt: receivedAt,
      updatedAt: now
    });
    this.audit("system", input.workspaceId, "mail.detected", "mailbox", mailbox.id, {
      provider: input.provider,
      providerMessageId: input.providerMessageId
    });
    return { kind: "processed", mailboxId: mailbox.id };
  }

  async collectMailbox(session: Session, workspaceId: string, mailboxId: string, source: CollectionSource): Promise<CollectionEvent> {
    await this.requireMember(session, workspaceId);
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox || mailbox.workspaceId !== workspaceId) throw new NotFoundError("PO box not found.");
    if (!mailbox.mailWaiting) {
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
          email: user.email,
          displayName: user.displayName,
          role: member.role,
          status: member.status,
          active: user.active
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async listReviewItems(session: Session, workspaceId: string): Promise<ReviewItem[]> {
    await this.requireMember(session, workspaceId);
    return [...this.auditEvents.values()]
      .filter((event) => event.workspaceId === workspaceId && event.eventType === "mail.needs_review")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map((event) => ({
        id: event.id,
        providerMessageId: event.entityId,
        subject: typeof event.metadata.subject === "string" ? event.metadata.subject : undefined,
        mailboxNumber: typeof event.metadata.mailboxNumber === "string" ? event.metadata.mailboxNumber : undefined,
        confidence: typeof event.metadata.confidence === "number" ? event.metadata.confidence : undefined,
        createdAt: event.createdAt
      }));
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

  async createPostOffice(session: Session, workspaceId: string, input: CreatePostOfficeInput): Promise<PostOffice> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office: PostOffice = {
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

  async createMailbox(session: Session, workspaceId: string, input: CreateMailboxInput): Promise<Mailbox> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office = this.postOffices.get(input.postOfficeId);
    if (!office || office.workspaceId !== workspaceId) throw new NotFoundError("Post office not found.");
    if ([...this.mailboxes.values()].some((mailbox) => mailbox.workspaceId === workspaceId && mailbox.boxNumber === input.boxNumber)) {
      throw new ConflictError("PO box number already exists.");
    }
    const now = new Date().toISOString();
    const mailbox: Mailbox = {
      id: nanoid(),
      workspaceId,
      postOfficeId: input.postOfficeId,
      name: input.name,
      boxNumber: input.boxNumber,
      active: true,
      mailWaiting: false,
      updatedAt: now
    };
    this.mailboxes.set(mailbox.id, mailbox);
    this.audit(session.userId, workspaceId, "mailbox.created", "mailbox", mailbox.id, { boxNumber: mailbox.boxNumber });
    return mailbox;
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
