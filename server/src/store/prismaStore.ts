import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, recoveryCodeMatches, totpUri, verifyTotp } from "../auth/totp.js";
import { challengeFromClientData, webAuthnConfig } from "../auth/webauthn.js";
import { postOfficeDirectoryStatus, searchPostOfficeDirectory, syncPostOfficeDirectory, type PostOfficeDirectoryStatus } from "../lctr/postOfficeDirectory.js";
import type { LctrPostOfficeLocation } from "../lctr/postOfficeLookup.js";
import { appVersion, changesAfterVersion, compareVersions, isReleaseVersion } from "../releases.js";
import type {
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

interface RecoveryCodeRow {
  id: string;
  codeHash: string;
}

interface PasskeyCredentialRow {
  credentialId: string;
  transports: string[];
}

interface MemberWithUserRow {
  updatedAt: Date;
  user: {
    id: string;
    email: string;
    active: boolean;
    profile: { displayName: string } | null;
  };
  role: TeamMemberSummary["role"];
  status: TeamMemberSummary["status"];
}

interface ReviewAuditRow {
  id: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
}

interface ReviewMatchAuditRow {
  workspaceId: string;
  entityId: string;
  eventType: string;
  metadata: unknown;
}

export class PrismaStore implements AppStore {
  async checkReadiness(): Promise<void> {
    await this.prisma.workspace.count();
  }
  constructor(private readonly prisma = new PrismaClient()) {}

  async seedDemo() {
    const seedDemo = process.env.POBOX_WATCH_SEED_DEMO ?? process.env.MAILBOX_SEED_DEMO;
    if (process.env.NODE_ENV === "production" && seedDemo !== "true") return;
    const passwordHash = await argon2.hash("Password123!");
    await this.prisma.workspace.upsert({
      where: { id: "ws_company" },
      update: { name: "pobox.watch Workspace" },
      create: { id: "ws_company", name: "pobox.watch Workspace" }
    });

    const users = [
      ["usr_daniel", "daniel@example.com", "Daniel", "ADMIN"],
      ["usr_sarah", "sarah@example.com", "Sarah", "MEMBER"],
      ["usr_john", "john@example.com", "John", "MEMBER"]
    ] as const;
    for (const [id, email, displayName, role] of users) {
      await this.prisma.user.upsert({
        where: { id },
        update: {},
        create: {
          id,
          email,
          passwordHash,
          emailVerified: true,
          active: true,
          profile: { create: { displayName } },
          memberships: {
            create: {
              id: `mem_${id}`,
              workspaceId: "ws_company",
              role,
              status: "ACTIVE",
              joinedAt: new Date()
            }
          }
        }
      });
      await this.prisma.userProfile.upsert({
        where: { userId: id },
        update: { displayName },
        create: { userId: id, displayName }
      });
      await this.prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: "ws_company", userId: id } },
        update: { role, status: "ACTIVE" },
        create: { id: `mem_${id}`, workspaceId: "ws_company", userId: id, role, status: "ACTIVE", joinedAt: new Date() }
      });
    }

    const offices = [
      ["po_melbourne_gpo", "Melbourne GPO", "350 Bourke Street, Melbourne VIC", "+61 13 13 18", -37.8136, 144.9631],
      ["po_south_melbourne", "South Melbourne Post Office", "113-115 Clarendon Street, South Melbourne VIC", "+61 13 13 18", -37.8327, 144.9604],
      ["po_richmond", "Richmond Post Office", "382 Bridge Road, Richmond VIC", "+61 13 13 18", -37.8186, 145.0018]
    ] as const;
    for (const [id, name, address, phone, latitude, longitude] of offices) {
      await this.prisma.postOffice.upsert({
        where: { id },
        update: { name, address, phone, latitude, longitude, active: true },
        create: { id, workspaceId: "ws_company", name, address, phone, latitude, longitude, geofenceRadius: 200, active: true }
      });
    }

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
      await this.prisma.mailbox.upsert({
        where: { id },
        update: { name, boxNumber, postOfficeId, active: true },
        create: { id, workspaceId: "ws_company", postOfficeId, name, boxNumber, active: true }
      });
    }
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() }, include: { profile: true } });
    if (!user || !user.active || !(await this.prisma.workspaceMember.count({ where: { userId: user.id, status: "ACTIVE" } })) || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedError("Invalid email or password.");
    }
    if (user.totpEnabled) {
      const expiresAt = new Date(Date.now() + 1000 * 60 * 10);
      const challenge = await this.prisma.authChallenge.create({
        data: { id: randomBytes(32).toString("base64url"), userId: user.id, expiresAt }
      });
      return {
        kind: "two_factor_required",
        challengeId: challenge.id,
        expiresAt: challenge.expiresAt.toISOString(),
        methods: ["totp", "recovery_code"]
      };
    }
    return { kind: "session", ...(await this.createSession(user.id, user.lastLoginAt?.toISOString())) };
  }

  async verifySecondFactor(challengeId: string, code: string): Promise<Session> {
    const challenge = await this.prisma.authChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
    if (!challenge || challenge.expiresAt.getTime() < Date.now()) throw new UnauthorizedError("Two-factor challenge expired.");
    if (!challenge.user.active || !challenge.user.totpEnabled || !challenge.user.totpSecretEncrypted) {
      throw new UnauthorizedError("Two-factor authentication is not enabled.");
    }
    const validTotp = verifyTotp(decryptSecret(challenge.user.totpSecretEncrypted), code);
    const availableRecoveryCodes = await this.prisma.recoveryCode.findMany({
      where: { userId: challenge.userId, usedAt: null }
    });
    const recovery = (availableRecoveryCodes as RecoveryCodeRow[]).find((candidate) => recoveryCodeMatches(code, candidate.codeHash));
    if (!validTotp && !recovery) throw new UnauthorizedError("Invalid two-factor code.");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${challenge.userId} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: challenge.userId } });
      if (!current?.active || !current.totpEnabled || current.totpSecretEncrypted !== challenge.user.totpSecretEncrypted) throw new UnauthorizedError("Security settings changed. Please sign in again.");
      if (recovery) {
        const consumed = await tx.recoveryCode.updateMany({ where: { id: recovery.id, usedAt: null }, data: { usedAt: new Date() } });
        if (consumed.count !== 1) throw new UnauthorizedError("Recovery code already used.");
      }
      const consumed = await tx.authChallenge.deleteMany({ where: { id: challenge.id, expiresAt: { gt: new Date() } } });
      if (consumed.count !== 1) throw new UnauthorizedError("Two-factor challenge expired or already used.");
      const session = await tx.session.create({ data: { id: randomBytes(32).toString("base64url"), userId: challenge.userId, expiresAt: new Date(Date.now() + 14 * 86400000), secondFactorVerified: true } });
      await tx.user.update({ where: { id: challenge.userId }, data: { lastLoginAt: new Date() } });
      return { ...this.toSession(session), previousLoginAt: challenge.user.lastLoginAt?.toISOString() };
    });
  }

  async createSessionForUser(userId: string): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.active) throw new UnauthorizedError("Missing user.");
    return this.createSession(user.id, user.lastLoginAt?.toISOString(), true);
  }

  async securityStatus(session: Session): Promise<SecurityStatus> {
    const [user, passkeyCount, recoveryCodesRemaining] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: session.userId } }),
      this.prisma.passkeyCredential.count({ where: { userId: session.userId } }),
      this.prisma.recoveryCode.count({ where: { userId: session.userId, usedAt: null } })
    ]);
    if (!user) throw new UnauthorizedError("Missing user.");
    return { passkeysAvailable: this.passkeysAvailable(), passkeyCount, totpEnabled: user.totpEnabled, recoveryCodesRemaining };
  }

  async appChanges(session: Session, workspaceId: string): Promise<AppChangesResult> {
    const [member, user] = await Promise.all([
      this.requireMember(session, workspaceId),
      this.prisma.user.findUnique({
        where: { id: session.userId },
        select: { lastSeenReleaseVersion: true }
      })
    ]);
    if (!user) throw new UnauthorizedError("Missing user.");
    return {
      version: appVersion,
      lastSeenVersion: user.lastSeenReleaseVersion ?? undefined,
      changes: changesAfterVersion(user.lastSeenReleaseVersion ?? undefined, member.role)
    };
  }

  async markAppChangesSeen(session: Session, workspaceId: string, version: string): Promise<AppChangesResult> {
    await this.requireMember(session, workspaceId);
    if (!isReleaseVersion(version)) throw new ConflictError("Unknown release version.");
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${session.userId} FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: session.userId } });
      if (user.lastSeenReleaseVersion && compareVersions(version, user.lastSeenReleaseVersion) <= 0) return;
      await tx.user.update({
        where: { id: session.userId },
        data: {
          lastSeenReleaseVersion: version,
          lastSeenReleaseAt: new Date()
        }
      });
    });
    return this.appChanges(session, workspaceId);
  }

  async beginTotpSetup(session: Session, proof?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) throw new UnauthorizedError("Missing user.");
    const secret = generateTotpSecret();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      if (user.totpEnabled) {
        const codes = await tx.recoveryCode.findMany({ where: { userId: user.id, usedAt: null } });
        const recovery = codes.find(candidate => recoveryCodeMatches(proof ?? "", candidate.codeHash));
        if (!proof || (!recovery && !verifyTotp(decryptSecret(user.totpSecretEncrypted!), proof))) throw new UnauthorizedError("Enter a current authenticator or unused recovery code.");
        if (recovery) {
          const consumed = await tx.recoveryCode.updateMany({ where: { id: recovery.id, usedAt: null }, data: { usedAt: new Date() } });
          if (consumed.count !== 1) throw new UnauthorizedError("Recovery code already used.");
        }
      }
      const updated = await tx.user.updateMany({ where: { id: user.id, active: true, totpSecretEncrypted: user.totpSecretEncrypted }, data: { totpPendingSecretEncrypted: encryptSecret(secret), totpPendingSessionId: session.id, totpPendingExpiresAt: new Date(Date.now() + 600000) } });
      if (updated.count !== 1) throw new ConflictError("Security settings changed. Please sign in again.");
    });
    return { secret, otpauthUrl: totpUri(secret, user.email) };
  }

  async confirmTotpSetup(session: Session, code: string): Promise<ConfirmTotpResult> {
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user?.totpPendingSecretEncrypted) throw new ConflictError("Start 2FA setup before confirming.");
    if (user.totpPendingSessionId !== session.id || !user.totpPendingExpiresAt || user.totpPendingExpiresAt.getTime() <= Date.now()) throw new UnauthorizedError("Authenticator setup expired. Start again in this session.");
    const secret = decryptSecret(user.totpPendingSecretEncrypted);
    if (!verifyTotp(secret, code)) throw new UnauthorizedError("Invalid two-factor code.");
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: user.id, active: true, totpPendingSecretEncrypted: user.totpPendingSecretEncrypted, totpPendingSessionId: session.id, totpPendingExpiresAt: { gt: new Date() } },
        data: {
          totpSecretEncrypted: user.totpPendingSecretEncrypted,
          totpPendingSecretEncrypted: null,
          totpPendingSessionId: null,
          totpPendingExpiresAt: null,
          totpEnabled: true,
          totpConfirmedAt: new Date()
        }
      });
      if (updated.count !== 1) throw new ConflictError("Authenticator setup already completed or replaced.");
      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.createMany({ data: recoveryCodes.map(code => ({ userId: user.id, codeHash: hashRecoveryCode(code) })) });
      await tx.session.deleteMany({ where: { userId: user.id, id: { not: session.id } } });
      await tx.session.update({ where: { id: session.id }, data: { secondFactorVerified: true } });
      await tx.authChallenge.deleteMany({ where: { userId: user.id } });
    });
    return { recoveryCodes };
  }

  async disableTotp(session: Session, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user?.totpEnabled || !user.totpSecretEncrypted) throw new ConflictError("2FA is not enabled.");
    if (!verifyTotp(decryptSecret(user.totpSecretEncrypted), code)) throw new UnauthorizedError("Invalid two-factor code.");
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.authChallenge.deleteMany({ where: { userId: user.id } }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { totpEnabled: false, totpSecretEncrypted: null, totpPendingSecretEncrypted: null, totpConfirmedAt: null }
      })
    ]);
  }

  async beginPasskeyRegistration(session: Session): Promise<PasskeyRegistrationOptions> {
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      include: { profile: true, passkeyCredentials: true }
    });
    if (!user) throw new UnauthorizedError("Missing user.");
    const config = webAuthnConfig();
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: user.email,
      userID: Uint8Array.from(Buffer.from(user.id)),
      userDisplayName: user.profile?.displayName ?? user.email,
      attestationType: "none",
      excludeCredentials: (user.passkeyCredentials as PasskeyCredentialRow[]).map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as Array<"ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" }
    });
    await this.prisma.webAuthnChallenge.create({
      data: {
        userId: user.id,
        type: "registration",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + 1000 * 60 * 10)
      }
    });
    return { options };
  }

  async verifyPasskeyRegistration(session: Session, response: RegistrationResponseJSON, friendlyName?: string): Promise<SecurityStatus> {
    const responseChallenge = challengeFromClientData(response.response.clientDataJSON);
    const [user, challenge] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: session.userId } }),
      this.prisma.webAuthnChallenge.findFirst({
        where: { userId: session.userId, type: "registration", challenge: responseChallenge, expiresAt: { gt: new Date() } }
      })
    ]);
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
    await this.prisma.$transaction([
      this.prisma.passkeyCredential.create({
        data: {
          userId: user.id,
          credentialId: verification.registrationInfo.credential.id,
          publicKey: Buffer.from(verification.registrationInfo.credential.publicKey),
          counter: verification.registrationInfo.credential.counter,
          transports: verification.registrationInfo.credential.transports ?? [],
          friendlyName: friendlyName?.trim() || "Passkey"
        }
      }),
      this.prisma.webAuthnChallenge.deleteMany({ where: { userId: user.id, type: "registration" } })
    ]);
    return this.securityStatus(session);
  }

  async beginPasskeyAuthentication(email?: string): Promise<PasskeyAuthenticationOptions> {
    const user = email ? await this.prisma.user.findUnique({ where: { email: email.toLowerCase() }, include: { passkeyCredentials: true } }) : null;
    const allowedCredentials = (user?.passkeyCredentials as PasskeyCredentialRow[] | undefined)?.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports as Array<"ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">
    }));
    const config = webAuthnConfig();
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: allowedCredentials && allowedCredentials.length > 0 ? allowedCredentials : undefined,
      userVerification: "required"
    });
    await this.prisma.webAuthnChallenge.create({
      data: {
        userId: user?.id,
        type: "authentication",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + 1000 * 60 * 10)
      }
    });
    return { options };
  }

  async verifyPasskeyAuthentication(response: AuthenticationResponseJSON): Promise<LoginResult> {
    const credential = await this.prisma.passkeyCredential.findUnique({
      where: { credentialId: response.id },
      include: { user: true }
    });
    if (!credential || !credential.user.active) throw new UnauthorizedError("Passkey is not registered.");
    const responseChallenge = challengeFromClientData(response.response.clientDataJSON);
    const challenge = await this.prisma.webAuthnChallenge.findFirst({
      where: {
        type: "authentication",
        challenge: responseChallenge,
        OR: [{ userId: null }, { userId: credential.userId }],
        expiresAt: { gt: new Date() }
      }
    });
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
        publicKey: new Uint8Array(credential.publicKey).slice(),
        counter: Number(credential.counter),
        transports: credential.transports as Array<"ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">
      }
    });
    if (!verification.verified) throw new UnauthorizedError("Passkey sign-in could not be verified.");
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.webAuthnChallenge.deleteMany({ where: { id: challenge.id, expiresAt: { gt: new Date() } } });
      if (consumed.count !== 1) throw new UnauthorizedError("Passkey sign-in expired or already used.");
      const updated = await tx.passkeyCredential.updateMany({
        where: { id: credential.id, counter: credential.counter },
        data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() }
      });
      if (updated.count !== 1) throw new UnauthorizedError("Passkey changed. Please try again.");
    });
    if (credential.user.totpEnabled) {
      const expiresAt = new Date(Date.now() + 1000 * 60 * 10);
      const authChallenge = await this.prisma.authChallenge.create({
        data: { id: randomBytes(32).toString("base64url"), userId: credential.userId, expiresAt }
      });
      return {
        kind: "two_factor_required",
        challengeId: authChallenge.id,
        expiresAt: authChallenge.expiresAt.toISOString(),
        methods: ["totp", "recovery_code"]
      };
    }
    return { kind: "session", ...(await this.createSession(credential.userId, credential.user.lastLoginAt?.toISOString())) };
  }

  private async createSession(userId: string, previousLoginAt?: string, secondFactorVerified = false): Promise<Session> {
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
    const session = await this.prisma.session.create({
      data: { id: randomBytes(32).toString("base64url"), userId, expiresAt, secondFactorVerified }
    });
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    return { ...this.toSession(session), previousLoginAt };
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
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, include: { user: { select: { active: true, totpEnabled: true } } } });
    if (!session || session.expiresAt.getTime() <= Date.now() || !session.user.active) throw new UnauthorizedError("Session expired.");
    if (session.user.totpEnabled && !session.secondFactorVerified) throw new UnauthorizedError("Please sign in again with two-factor authentication.");
    return this.toSession(session);
  }

  async revokeSession(sessionId?: string): Promise<void> {
    if (sessionId) await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  async requireMember(session: Session, workspaceId: string, role?: "ADMIN"): Promise<WorkspaceMember> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId: session.userId, status: "ACTIVE", user: { active: true } }
    });
    if (!member) throw new ForbiddenError("Workspace access denied.");
    if (role && member.role !== role) throw new ForbiddenError("Admin role required.");
    return {
      id: member.id,
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      status: member.status
    };
  }

  async dashboard(session: Session, workspaceId: string): Promise<DashboardSnapshot> {
    const member = await this.requireMember(session, workspaceId);
    const [workspace, user, offices, mailEvents, collectionEvents] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId } }),
      this.prisma.user.findUnique({ where: { id: session.userId }, include: { profile: true } }),
      this.prisma.postOffice.findMany({
        where: { workspaceId, active: true },
        orderBy: { name: "asc" },
        include: { mailboxes: { where: { active: true }, orderBy: { boxNumber: "asc" } } }
      }),
      this.prisma.mailEvent.findMany({ where: { workspaceId }, orderBy: { processedAt: "desc" }, take: 50 }),
      this.prisma.collectionEvent.findMany({ where: { workspaceId }, orderBy: { collectedAt: "desc" }, take: 50 })
    ]);
    if (!workspace || !user) throw new NotFoundError("Workspace not found.");
    const history = [...mailEvents.map(this.toMailEvent), ...collectionEvents.map(this.toCollectionEvent)].sort((a, b) => {
      const left = "processedAt" in a ? a.processedAt : a.collectedAt;
      const right = "processedAt" in b ? b.processedAt : b.collectedAt;
      return right.localeCompare(left);
    });
    return {
      workspace: { id: workspace.id, name: workspace.name },
      currentUser: {
        id: user.id,
        email: user.email,
        displayName: user.profile?.displayName ?? user.email,
        role: member.role
      },
      outstandingMailboxCount: await this.outstandingMailboxCount(workspaceId),
      postOffices: offices.map((office: (typeof offices)[number]) => ({
        ...this.toPostOffice(office),
        mailboxes: office.mailboxes.map(this.toMailbox)
      })),
      history
    };
  }

  async outstandingMailboxCount(workspaceId: string): Promise<number> {
    return this.prisma.mailbox.count({ where: { workspaceId, active: true, OR: [{ mailWaiting: true }, { parcelWaiting: true }] } });
  }

  async processIncomingMail(input: IncomingProviderMessage): Promise<IncomingMailResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockMailMessage(tx, input.workspaceId, input.provider, input.providerMessageId);
      const result = await this.processMailTransaction(tx, input);
      if (result.kind !== "needs_review") await this.queueMailAcknowledgement(tx, input.workspaceId, input.provider, input.providerMessageId);
      return result;
    }, { timeout: 15000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private async lockMailMessage(tx: Prisma.TransactionClient, workspaceId: string, provider: string, messageId: string) {
    const key = JSON.stringify([workspaceId, provider, messageId]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
  }

  private async queueMailAcknowledgement(tx: Prisma.TransactionClient, workspaceId: string, provider: string, providerMessageId: string) {
    const identity = { workspaceId, provider, providerMessageId };
    await tx.mailAcknowledgement.upsert({ where: { workspaceId_provider_providerMessageId: identity }, create: identity, update: {} });
    // A previously acknowledged email may have been made unread again.
    await tx.mailAcknowledgement.updateMany({ where: { ...identity, acknowledgedAt: { not: null } }, data: { acknowledgedAt: null, nextAttemptAt: new Date(), attempts: 0, lastError: null } });
  }

  async pendingMailAcknowledgements(workspaceId: string, provider: string): Promise<string[]> {
    const rows = await this.prisma.mailAcknowledgement.findMany({
      where: { workspaceId, provider, acknowledgedAt: null, nextAttemptAt: { lte: new Date() } },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }], take: 100
    });
    return rows.map((row) => row.providerMessageId);
  }

  async acknowledgeMail(workspaceId: string, provider: string, providerMessageId: string) {
    await this.prisma.mailAcknowledgement.updateMany({ where: { workspaceId, provider, providerMessageId, acknowledgedAt: null }, data: { acknowledgedAt: new Date(), lastError: null } });
  }

  async failMailAcknowledgement(workspaceId: string, provider: string, providerMessageId: string, reason: string) {
    await this.prisma.mailAcknowledgement.updateMany({
      where: { workspaceId, provider, providerMessageId, acknowledgedAt: null },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 60000), lastError: reason.slice(0, 200) }
    });
  }

  private async processMailTransaction(tx: Prisma.TransactionClient, input: IncomingProviderMessage): Promise<IncomingMailResult> {
    const existing = await tx.mailEvent.findUnique({
      where: {
        workspaceId_provider_providerMessageId: {
          workspaceId: input.workspaceId,
          provider: input.provider,
          providerMessageId: input.providerMessageId
        }
      }
    });
    if (existing) return { kind: "duplicate", mailboxId: existing.mailboxId, notificationType: existing.notificationType === "PARCEL" ? "PARCEL" : "MAIL" };

    // A thread can contain notifications from different days. Only the message
    // identity owns a review decision, which must survive later box changes.
    const reviewMatches = await tx.auditEvent.findMany({
      where: {
        workspaceId: input.workspaceId,
        entityId: input.providerMessageId,
        eventType: { in: ["mail.needs_review", "mail.review_resolved", "mail.review_ignored", "mail.review_dismissed"] }
      },
      orderBy: { createdAt: "desc" }
    });
    const reviewEvents = (reviewMatches as ReviewMatchAuditRow[]).filter((event) => reviewMatchesProviderMessage(event, input));
    const existingReview = reviewEvents.find((event) => event.eventType === "mail.needs_review");
    if (existingReview) {
      const notificationType = notificationTypeFromMetadata(metadataRecord(existingReview.metadata), "MAIL");
      return reviewEvents.some((event) => isReviewResolutionEvent(event.eventType))
        ? { kind: "duplicate", notificationType }
        : { kind: "needs_review", notificationType };
    }

    const [boxes, postOffices] = await Promise.all([
      tx.mailbox.findMany({ where: { workspaceId: input.workspaceId } }),
      tx.postOffice.findMany({ where: { workspaceId: input.workspaceId } })
    ]);
    const parsed = parseMailNotification(input, boxes.map(this.toMailbox), postOffices.map(this.toPostOffice));
    if (!parsed.mailboxId || parsed.requiresReview) {
      await this.audit("system", input.workspaceId, "mail.needs_review", "mail_message", input.providerMessageId, {
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
      }, tx);
      return { kind: "needs_review", notificationType: parsed.notificationType };
    }

    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    await Promise.all([
      tx.mailEvent.create({
        data: {
          workspaceId: input.workspaceId,
          mailboxId: parsed.mailboxId,
          provider: input.provider,
          providerMessageId: input.providerMessageId,
          sender: input.sender,
          subject: input.subject,
          notificationType: parsed.notificationType,
          receivedAt,
          parserConfidence: parsed.confidence,
          parserRuleId: parsed.ruleId
        }
      }),
      tx.mailbox.update({
        where: { id: parsed.mailboxId },
        data: parsed.notificationType === "PARCEL"
          ? { parcelWaiting: true, latestParcelNotificationAt: receivedAt }
          : { mailWaiting: true, latestNotificationAt: receivedAt }
      }),
      tx.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: undefined,
          eventType: parsed.notificationType === "PARCEL" ? "parcel.detected" : "mail.detected",
          entityType: "mailbox",
          entityId: parsed.mailboxId,
          metadata: { provider: input.provider, providerMessageId: input.providerMessageId, notificationType: parsed.notificationType }
        }
      })
    ]);
    return { kind: "processed", mailboxId: parsed.mailboxId, notificationType: parsed.notificationType };
  }

  async collectMailbox(session: Session, workspaceId: string, mailboxId: string, source: CollectionSource, expectedUpdatedAt?: string): Promise<CollectionEvent> {
    await this.requireMember(session, workspaceId);
    const event = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockManagement(tx, workspaceId, session, false);
      const updated = await tx.mailbox.updateMany({
        where: { id: mailboxId, workspaceId, active: true, ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}), OR: [{ mailWaiting: true }, { parcelWaiting: true }] },
        data: { mailWaiting: false, parcelWaiting: false, lastCollectedAt: new Date(), lastCollectedBy: session.userId }
      });
      if (updated.count !== 1) {
        const mailbox = await tx.mailbox.findFirst({ where: { id: mailboxId, workspaceId } });
        if (!mailbox) throw new NotFoundError("PO box not found.");
        if (expectedUpdatedAt && mailbox.updatedAt.toISOString() !== expectedUpdatedAt) throw new ConflictError("This PO box changed. Refresh before collecting.");
        const existing = await tx.collectionEvent.findFirst({ where: { mailboxId }, orderBy: { collectedAt: "desc" } });
        throw new ConflictError(
          existing ? `Already collected at ${existing.collectedAt.toISOString()} by ${existing.collectedBy}.` : "PO box is already clear."
        );
      }
      const collection = await tx.collectionEvent.create({
        data: { workspaceId, mailboxId, collectedBy: session.userId, source, method: "explicit_confirmation" }
      });
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorUserId: session.userId,
          eventType: "mailbox.collected",
          entityType: "mailbox",
          entityId: mailboxId,
          metadata: { source }
        }
      });
      return collection;
    });
    return this.toCollectionEvent(event);
  }

  async listMembers(session: Session, workspaceId: string): Promise<TeamMemberSummary[]> {
    await this.requireMember(session, workspaceId);
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      include: { user: { include: { profile: true } } }
    });
    return members
      .map((member): TeamMemberSummary => ({
        version: member.updatedAt.toISOString(),
        deletedAt: member.deletedAt?.toISOString(),
        id: member.user.id,
        email: member.user.email,
        displayName: member.user.profile?.displayName ?? member.user.email,
        role: member.role,
        status: member.status,
        active: member.user.active && member.status === "ACTIVE"
      }))
      .sort((a: TeamMemberSummary, b: TeamMemberSummary) => a.displayName.localeCompare(b.displayName));
  }

  private async activeAdminCount(workspaceId: string): Promise<number> {
    return this.prisma.workspaceMember.count({
      where: {
        workspaceId,
        role: "ADMIN",
        status: "ACTIVE",
        user: { active: true }
      }
    });
  }

  private async assertUserManagementChangeIsSafe(
    session: Session,
    workspaceId: string,
    userId: string,
    member: { role: TeamMemberSummary["role"]; status: TeamMemberSummary["status"] },
    nextRole: TeamMemberSummary["role"],
    nextStatus: TeamMemberSummary["status"]
  ) {
    if (session.userId === userId && nextRole !== member.role) {
      throw new ConflictError("You cannot change your own role.");
    }
    if (session.userId === userId && nextStatus !== member.status) {
      throw new ConflictError("You cannot change your own access status.");
    }
    if (member.role === "ADMIN" && member.status === "ACTIVE" && (nextRole !== "ADMIN" || nextStatus !== "ACTIVE") && (await this.activeAdminCount(workspaceId)) <= 1) {
      throw new ConflictError("At least one active admin is required.");
    }
  }

  async listReviewItems(session: Session, workspaceId: string): Promise<ReviewItem[]> {
    await this.requireMember(session, workspaceId);
    const [events, resolutions] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: { workspaceId, eventType: "mail.needs_review" },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.auditEvent.findMany({
        where: { workspaceId, eventType: { in: ["mail.review_resolved", "mail.review_ignored", "mail.review_dismissed"] } },
        select: { entityId: true, metadata: true }
      })
    ]);
    const key = (event: { entityId: string; metadata: unknown }) => JSON.stringify([metadataRecord(event.metadata).provider ?? "review", event.entityId]);
    const resolvedProviderMessages = new Set(resolutions.map(key));
    return (events as ReviewAuditRow[]).filter((event) => !resolvedProviderMessages.has(key(event))).map((event) => {
      const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
        ? event.metadata as Record<string, unknown>
        : {};
      return {
        id: event.id,
        providerMessageId: event.entityId,
        provider: typeof metadata.provider === "string" ? metadata.provider : undefined,
        sender: typeof metadata.sender === "string" ? metadata.sender : undefined,
        subject: typeof metadata.subject === "string" ? metadata.subject : undefined,
        bodyPreview: typeof metadata.bodyPreview === "string" ? mailText(metadata.bodyPreview) : undefined,
        mailboxNumber: typeof metadata.mailboxNumber === "string" ? metadata.mailboxNumber : undefined,
        postOfficeName: typeof metadata.postOfficeName === "string" ? metadata.postOfficeName : undefined,
        notificationType: metadata.notificationType === "PARCEL" ? "PARCEL" : "MAIL",
        confidence: typeof metadata.confidence === "number" ? metadata.confidence : undefined,
        reason: typeof metadata.reason === "string" ? metadata.reason : reviewReasonFromMetadata(metadata),
        receivedAt: typeof metadata.receivedAt === "string" ? metadata.receivedAt : undefined,
        createdAt: event.createdAt.toISOString()
      };
    });
  }

  async resolveReviewItem(session: Session, workspaceId: string, reviewItemId: string, mailboxId: string, newMailbox?: { postOfficeId: string; boxNumber: string }): Promise<IncomingMailResult> {
    return this.completeReview(session, workspaceId, reviewItemId, "mail.review_resolved", mailboxId || undefined, newMailbox);
  }

  private async completeReview(session: Session, workspaceId: string, reviewItemId: string, eventType: "mail.review_resolved" | "mail.review_ignored", mailboxId?: string, newMailbox?: { postOfficeId: string; boxNumber: string }): Promise<IncomingMailResult> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const review = await tx.auditEvent.findFirst({ where: { id: reviewItemId, workspaceId, eventType: "mail.needs_review" } });
      if (!review) throw new NotFoundError("Review item not found.");
      const metadata = review.metadata && typeof review.metadata === "object" && !Array.isArray(review.metadata)
        ? review.metadata as Record<string, unknown>
        : {};
      const provider = typeof metadata.provider === "string" ? metadata.provider : "review";
      await this.lockMailMessage(tx, workspaceId, provider, review.entityId);
      const priorDecisions = await tx.auditEvent.findMany({ where: {
        workspaceId, entityId: review.entityId,
        eventType: { in: ["mail.review_resolved", "mail.review_ignored", "mail.review_dismissed"] }
      } });
      const prior = priorDecisions.find((event) => {
        const record = metadataRecord(event.metadata);
        return (record.provider ?? "review") === provider;
      });
      if (prior) {
        const record = metadataRecord(prior.metadata);
        if (newMailbox) {
          if (record.postOfficeId !== newMailbox.postOfficeId || record.boxNumber !== normalizeMailboxNumber(newMailbox.boxNumber)) throw new ConflictError("This review item was already handled.");
          mailboxId = typeof record.mailboxId === "string" ? record.mailboxId : undefined;
        }
        if (prior.eventType !== eventType || record.mailboxId !== mailboxId) throw new ConflictError("This review item was already handled.");
        await this.queueMailAcknowledgement(tx, workspaceId, provider, review.entityId);
        return { kind: "duplicate", mailboxId, notificationType: metadata.notificationType === "PARCEL" ? "PARCEL" : "MAIL" };
      }
      if (newMailbox) {
        const boxNumber = normalizeMailboxNumber(newMailbox.boxNumber);
        if (!boxNumber) throw new ConflictError("Enter a PO box number.");
        const offices = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "PostOffice" WHERE id = ${newMailbox.postOfficeId} AND "workspaceId" = ${workspaceId} AND active = true FOR UPDATE`;
        if (!offices.length) throw new NotFoundError("Post office not found.");
        const boxes = await tx.mailbox.findMany({ where: { workspaceId, postOfficeId: newMailbox.postOfficeId } });
        if (boxes.some((box) => normalizeMailboxNumber(box.boxNumber) === boxNumber)) throw new ConflictError("This post office already has that PO box number. Select the existing box or restore it first.");
        const created = await tx.mailbox.create({ data: { workspaceId, postOfficeId: newMailbox.postOfficeId, boxNumber, name: `PO Box ${boxNumber}` } });
        mailboxId = created.id;
        await this.audit(session.userId, workspaceId, "mailbox.created", "mailbox", mailboxId, { boxNumber, reviewItemId }, tx);
      }
      if (mailboxId && !await tx.mailbox.findFirst({ where: { id: mailboxId, workspaceId, active: true } })) throw new NotFoundError("PO box not found.");
      const notificationType = metadata.notificationType === "PARCEL" ? "PARCEL" : "MAIL";
      const receivedAt = typeof metadata.receivedAt === "string" ? new Date(metadata.receivedAt) : review.createdAt;
      const duplicate = await tx.mailEvent.findUnique({
        where: {
          workspaceId_provider_providerMessageId: {
            workspaceId,
            provider,
            providerMessageId: review.entityId
          }
        }
      });

      if (duplicate && duplicate.mailboxId !== mailboxId) throw new ConflictError("This message was already matched to another PO box.");
      if (!duplicate && mailboxId) {
        await Promise.all([
          tx.mailEvent.create({
            data: {
              workspaceId,
              mailboxId,
              provider,
              providerMessageId: review.entityId,
              sender: typeof metadata.sender === "string" ? metadata.sender : "review",
              subject: typeof metadata.subject === "string" ? metadata.subject : "Reviewed mail notification",
              notificationType,
              receivedAt,
              parserConfidence: typeof metadata.confidence === "number" ? metadata.confidence : 1,
              parserRuleId: "manual-review"
            }
          }),
          tx.mailbox.update({
            where: { id: mailboxId },
            data: notificationType === "PARCEL"
              ? { parcelWaiting: true, latestParcelNotificationAt: receivedAt }
              : { mailWaiting: true, latestNotificationAt: receivedAt }
          })
        ]);
      }

      await this.audit(session.userId, workspaceId, eventType, "mail_message", review.entityId, {
        reviewItemId,
        mailboxId,
        postOfficeId: newMailbox?.postOfficeId,
        boxNumber: newMailbox ? normalizeMailboxNumber(newMailbox.boxNumber) : undefined,
        provider,
        providerThreadId: typeof metadata.providerThreadId === "string" ? metadata.providerThreadId : undefined
      }, tx);
      await this.queueMailAcknowledgement(tx, workspaceId, provider, review.entityId);
      return { kind: duplicate ? "duplicate" : "processed", mailboxId, notificationType };
    }, { timeout: 15000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async markReviewItemResolved(session: Session, workspaceId: string, reviewItemId: string): Promise<void> {
    await this.completeReview(session, workspaceId, reviewItemId, "mail.review_resolved");
  }

  async dismissReviewItem(session: Session, workspaceId: string, reviewItemId: string): Promise<void> {
    await this.completeReview(session, workspaceId, reviewItemId, "mail.review_ignored");
  }

  async searchPostOfficeLocations(session: Session, workspaceId: string, query: string): Promise<LctrPostOfficeLocation[]> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return searchPostOfficeDirectory(this.prisma, query);
  }

  async postOfficeDirectoryStatus(session: Session, workspaceId: string): Promise<PostOfficeDirectoryStatus> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return postOfficeDirectoryStatus(this.prisma);
  }

  async syncPostOfficeDirectory(session: Session, workspaceId: string): Promise<PostOfficeDirectoryStatus> {
    await this.requireMember(session, workspaceId, "ADMIN");
    await syncPostOfficeDirectory(this.prisma);
    return postOfficeDirectoryStatus(this.prisma);
  }

  async createUser(session: Session, workspaceId: string, input: CreateUserInput): Promise<TeamMemberSummary> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const email = input.email.toLowerCase();
    const passwordHash = await argon2.hash(input.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockManagement(tx, workspaceId, session);
        const user = await tx.user.create({
          data: {
            email,
            passwordHash,
            emailVerified: true,
            active: true,
            profile: { create: { displayName: input.displayName } },
            memberships: {
              create: {
                workspaceId,
                role: input.role,
                status: "ACTIVE",
                invitedBy: session.userId,
                joinedAt: new Date()
              }
            }
          },
          include: { profile: true, memberships: { where: { workspaceId } } }
        });
        await this.audit(session.userId, workspaceId, "member.created", "user", user.id, { email, role: input.role }, tx);
        return {
          id: user.id,
          email: user.email,
          displayName: user.profile?.displayName ?? user.email,
          role: user.memberships[0]?.role ?? input.role,
          status: user.memberships[0]?.status ?? "ACTIVE",
          active: user.active
        };
      });
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError("User email already exists.");
      }
      throw error;
    }
  }

  async updateUser(session: Session, workspaceId: string, userId: string, input: UpdateUserInput): Promise<TeamMemberSummary> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const actor = await tx.workspaceMember.findFirst({ where: { workspaceId, userId: session.userId, role: "ADMIN", status: "ACTIVE", user: { active: true } } });
      if (!actor) throw new ForbiddenError("Admin role required.");
      const member = await tx.workspaceMember.findFirst({
        where: { workspaceId, userId },
        include: { user: { include: { profile: true } } }
      });
      if (!member) throw new NotFoundError("User not found.");
      if (member.deletedAt) throw new ConflictError("Deleted users cannot be edited or reactivated.");
      if (input.expectedVersion && input.expectedVersion !== member.updatedAt.toISOString()) throw new ConflictError("This user's access changed. Cancel editing and reload before saving.");
      const nextRole = input.role ?? member.role;
      const nextStatus = input.status ?? member.status;
      if (session.userId === userId && (nextRole !== member.role || nextStatus !== member.status)) throw new ConflictError("You cannot change your own role or access status.");
      if (member.role === "ADMIN" && member.status === "ACTIVE" && (nextRole !== "ADMIN" || nextStatus !== "ACTIVE") && await tx.workspaceMember.count({ where: { workspaceId, role: "ADMIN", status: "ACTIVE", user: { active: true } } }) <= 1) throw new ConflictError("At least one active admin is required.");
      const changesIdentity = (input.email !== undefined && input.email.toLowerCase() !== member.user.email) || (input.displayName !== undefined && input.displayName !== (member.user.profile?.displayName ?? member.user.email));
      if (changesIdentity && await tx.workspaceMember.count({ where: { userId, workspaceId: { not: workspaceId } } })) throw new ForbiddenError("Shared account identity must be managed outside this workspace.");

      try {
        const updated = await tx.user.update({
          where: { id: userId },
          data: {
            ...(input.email ? { email: input.email.toLowerCase() } : {}),
            ...(input.displayName ? { profile: { upsert: { update: { displayName: input.displayName }, create: { displayName: input.displayName } } } } : {}),
            memberships: {
              update: {
                where: { workspaceId_userId: { workspaceId, userId } },
                data: { role: nextRole, status: nextStatus, updatedAt: new Date(Math.max(Date.now(), member.updatedAt.getTime() + 1)) }
              }
            }
          },
          include: { profile: true, memberships: { where: { workspaceId } } }
        });
        await this.audit(session.userId, workspaceId, "member.updated", "user", userId, {
          email: input.email?.toLowerCase(),
          displayName: input.displayName,
          role: input.role,
          status: input.status
        }, tx);
        return {
          id: updated.id,
          version: updated.memberships[0]?.updatedAt.toISOString(),
          email: updated.email,
          displayName: updated.profile?.displayName ?? updated.email,
          role: updated.memberships[0]?.role ?? member.role,
          status: updated.memberships[0]?.status ?? member.status,
          active: updated.active && nextStatus === "ACTIVE"
        };
      } catch (error) {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
          throw new ConflictError("User email already exists.");
        }
        throw error;
      }
    });
  }

  async deleteUser(session: Session, workspaceId: string, userId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    if (session.userId === userId) throw new ConflictError("You cannot delete your own user.");
    await this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (!member) throw new NotFoundError("User not found.");
      if (member.deletedAt) return;
      if (member.role === "ADMIN" && member.status === "ACTIVE" && await tx.workspaceMember.count({ where: { workspaceId, role: "ADMIN", status: "ACTIVE", user: { active: true } } }) <= 1) throw new ConflictError("At least one active admin is required.");
      await tx.workspaceMember.update({ where: { id: member.id }, data: { status: "DISABLED", deletedAt: new Date(), updatedAt: new Date(Math.max(Date.now(), member.updatedAt.getTime() + 1)) } });
      await this.audit(session.userId, workspaceId, "member.deleted", "user", userId, { historyPreserved: true }, tx);
    });
  }

  async createPostOffice(session: Session, workspaceId: string, input: CreatePostOfficeInput): Promise<PostOffice> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const office = await tx.postOffice.create({
        data: {
          workspaceId,
          name: input.name,
          address: input.address,
          phone: input.phone,
          latitude: input.latitude,
          longitude: input.longitude,
          geofenceRadius: input.geofenceRadius,
          active: true
        }
      });
      await this.audit(session.userId, workspaceId, "post_office.created", "post_office", office.id, { name: office.name }, tx);
      return this.toPostOffice(office);
    });
  }

  async updatePostOffice(session: Session, workspaceId: string, postOfficeId: string, input: UpdatePostOfficeInput): Promise<PostOffice> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const office = await tx.postOffice.findFirst({ where: { id: postOfficeId, workspaceId, active: true } });
      if (!office) throw new NotFoundError("Post office not found.");
      if (input.expectedUpdatedAt && input.expectedUpdatedAt !== office.updatedAt.toISOString()) throw new ConflictError("This post office changed. Cancel editing and reload before saving.");
      const updated = await tx.postOffice.update({
        where: { id: postOfficeId },
        data: {
          name: input.name,
          address: input.address,
          phone: input.phone,
          latitude: input.latitude,
          longitude: input.longitude,
          geofenceRadius: input.geofenceRadius,
          updatedAt: new Date(Math.max(Date.now(), office.updatedAt.getTime() + 1))
        }
      });
      await this.audit(session.userId, workspaceId, "post_office.updated", "post_office", postOfficeId, { name: updated.name }, tx);
      return this.toPostOffice(updated);
    });
  }

  async deletePostOffice(session: Session, workspaceId: string, postOfficeId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    await this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const offices = await tx.$queryRaw<Array<{ id: string; name: string }>>`SELECT id, name FROM "PostOffice" WHERE id = ${postOfficeId} AND "workspaceId" = ${workspaceId} AND active = true FOR UPDATE`;
      if (!offices.length) throw new NotFoundError("Post office not found.");
      await tx.mailbox.updateMany({ where: { workspaceId, postOfficeId }, data: { active: false } });
      await tx.postOffice.update({ where: { id: postOfficeId }, data: { active: false } });
      await this.audit(session.userId, workspaceId, "post_office.deleted", "post_office", postOfficeId, { name: offices[0].name, action: "archived_history_and_pending_review_preserved" }, tx);
    });
  }

  async createMailbox(session: Session, workspaceId: string, input: CreateMailboxInput): Promise<Mailbox> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return this.saveManagedMailbox(session, workspaceId, input);
  }

  async updateMailbox(session: Session, workspaceId: string, mailboxId: string, input: UpdateMailboxInput): Promise<Mailbox> {
    await this.requireMember(session, workspaceId, "ADMIN");
    return this.saveManagedMailbox(session, workspaceId, input, mailboxId);
  }

  private async lockManagement(tx: Prisma.TransactionClient, workspaceId: string, session: Session, admin = true) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`management:${workspaceId}`}, 0))::text`;
    const member = await tx.workspaceMember.findFirst({ where: { workspaceId, userId: session.userId, status: "ACTIVE", ...(admin ? { role: "ADMIN" as const } : {}), user: { active: true } } });
    if (!member) throw new ForbiddenError("Workspace permission changed. Refresh and try again.");
  }

  private async saveManagedMailbox(session: Session, workspaceId: string, input: UpdateMailboxInput, mailboxId?: string): Promise<Mailbox> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const existing = mailboxId ? await tx.mailbox.findFirst({ where: { id: mailboxId, workspaceId, active: true } }) : null;
      if (mailboxId && !existing) throw new NotFoundError("PO box not found.");
      if (existing && input.expectedUpdatedAt && input.expectedUpdatedAt !== existing.updatedAt.toISOString()) throw new ConflictError("This PO box changed. Cancel editing and reload before saving.");
      const postOfficeId = input.postOfficeId ?? existing?.postOfficeId ?? "";
      const boxNumber = normalizeMailboxNumber(input.boxNumber ?? existing?.boxNumber ?? "");
      if (!boxNumber) throw new ConflictError("Enter a PO box number.");
      // Share the destination lock with review-driven creation and archiving.
      const offices = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "PostOffice" WHERE id = ${postOfficeId} AND "workspaceId" = ${workspaceId} AND active = true FOR UPDATE`;
      if (!offices.length) throw new NotFoundError("Post office not found.");
      const boxes = await tx.mailbox.findMany({ where: { workspaceId, postOfficeId } });
      const duplicate = boxes.find((box) => box.id !== mailboxId && normalizeMailboxNumber(box.boxNumber) === boxNumber);
      if (duplicate) throw new ConflictError(duplicate.active ? "This post office already has that PO box number." : "This PO box number belongs to an archived record. Contact an administrator to restore it.");
      const data = { postOfficeId, boxNumber, name: `PO Box ${boxNumber}`, updatedAt: new Date(Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1)) };
      if (mailboxId) {
        const changed = await tx.mailbox.updateMany({ where: { id: mailboxId, workspaceId, active: true, updatedAt: existing!.updatedAt }, data });
        if (changed.count !== 1) throw new ConflictError("This PO box changed. Cancel editing and reload before saving.");
      }
      const saved = mailboxId ? await tx.mailbox.findUniqueOrThrow({ where: { id: mailboxId } }) : await tx.mailbox.create({ data: { ...data, workspaceId } });
      await this.audit(session.userId, workspaceId, mailboxId ? "mailbox.updated" : "mailbox.created", "mailbox", saved.id, { boxNumber, previousPostOfficeId: existing?.postOfficeId, previousBoxNumber: existing?.boxNumber }, tx);
      return this.toMailbox(saved);
    });
  }

  async deleteMailbox(session: Session, workspaceId: string, mailboxId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    await this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const mailbox = await tx.mailbox.findFirst({ where: { id: mailboxId, workspaceId, active: true } });
      if (!mailbox) throw new NotFoundError("PO box not found.");
      await tx.mailbox.update({ where: { id: mailboxId }, data: { active: false } });
      await this.audit(session.userId, workspaceId, "mailbox.deleted", "mailbox", mailboxId, { boxNumber: mailbox.boxNumber, action: "archived_history_and_pending_review_preserved" }, tx);
    });
  }

  async inviteMember(session: Session, workspaceId: string, email: string, role: "ADMIN" | "MEMBER") {
    await this.requireMember(session, workspaceId, "ADMIN");
    const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    return this.prisma.$transaction(async (tx) => {
      await this.lockManagement(tx, workspaceId, session);
      const invitation = await tx.invitation.create({
        data: {
          workspaceId,
          email: email.toLowerCase(),
          role,
          tokenHash,
          invitedBy: session.userId,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
        }
      });
      await this.audit(session.userId, workspaceId, "member.invited", "workspace", workspaceId, { email, role }, tx);
      return { invitationId: invitation.id, email, role, status: "PENDING_EMAIL_DELIVERY" };
    });
  }

  private async audit(actorUserId: string | undefined, workspaceId: string, eventType: string, entityType: string, entityId: string, metadata: Record<string, unknown>, database: Prisma.TransactionClient = this.prisma): Promise<AuditEvent> {
    const event = await database.auditEvent.create({
      data: { workspaceId, actorUserId, eventType, entityType, entityId, metadata: metadata as never }
    });
    return {
      id: event.id,
      workspaceId: event.workspaceId,
      actorUserId: event.actorUserId ?? undefined,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata as Record<string, unknown>,
      createdAt: event.createdAt.toISOString()
    };
  }

  private toSession(session: { id: string; userId: string; expiresAt: Date; secondFactorVerified: boolean }): Session {
    return { id: session.id, userId: session.userId, expiresAt: session.expiresAt.toISOString(), secondFactorVerified: session.secondFactorVerified };
  }

  private toPostOffice(office: {
    updatedAt: Date;
    id: string;
    workspaceId: string;
    name: string;
    address: string;
    phone: string | null;
    latitude: unknown;
    longitude: unknown;
    geofenceRadius: number;
    active: boolean;
  }): PostOffice {
    return {
      id: office.id,
      updatedAt: office.updatedAt.toISOString(),
      workspaceId: office.workspaceId,
      name: office.name,
      address: office.address,
      phone: office.phone ?? undefined,
      latitude: Number(office.latitude),
      longitude: Number(office.longitude),
      geofenceRadius: office.geofenceRadius,
      active: office.active
    };
  }

  private toMailbox(box: {
    id: string;
    workspaceId: string;
    postOfficeId: string;
    name: string;
    boxNumber: string;
    active: boolean;
    mailWaiting: boolean;
    parcelWaiting: boolean;
    latestNotificationAt: Date | null;
    latestParcelNotificationAt: Date | null;
    lastCollectedAt: Date | null;
    lastCollectedBy: string | null;
    updatedAt: Date;
  }): Mailbox {
    return {
      id: box.id,
      workspaceId: box.workspaceId,
      postOfficeId: box.postOfficeId,
      name: box.name,
      boxNumber: box.boxNumber,
      active: box.active,
      mailWaiting: box.mailWaiting,
      parcelWaiting: box.parcelWaiting,
      latestNotificationAt: box.latestNotificationAt?.toISOString(),
      latestParcelNotificationAt: box.latestParcelNotificationAt?.toISOString(),
      lastCollectedAt: box.lastCollectedAt?.toISOString(),
      lastCollectedBy: box.lastCollectedBy ?? undefined,
      updatedAt: box.updatedAt.toISOString()
    };
  }

  private toMailEvent(event: {
    id: string;
    workspaceId: string;
    mailboxId: string;
    provider: string;
    providerMessageId: string;
    sender: string;
    subject: string;
    notificationType: string;
    receivedAt: Date;
    parserConfidence: number;
    parserRuleId: string | null;
    processedAt: Date;
  }): MailEvent {
    return {
      id: event.id,
      workspaceId: event.workspaceId,
      mailboxId: event.mailboxId,
      provider: event.provider,
      providerMessageId: event.providerMessageId,
      sender: event.sender,
      subject: event.subject,
      notificationType: event.notificationType === "PARCEL" ? "PARCEL" : "MAIL",
      receivedAt: event.receivedAt.toISOString(),
      parserConfidence: event.parserConfidence,
      parserRuleId: event.parserRuleId ?? undefined,
      processedAt: event.processedAt.toISOString()
    };
  }

  private toCollectionEvent(event: {
    id: string;
    workspaceId: string;
    mailboxId: string;
    collectedBy: string;
    collectedAt: Date;
    source: CollectionSource;
    method: string;
  }): CollectionEvent {
    return {
      id: event.id,
      workspaceId: event.workspaceId,
      mailboxId: event.mailboxId,
      collectedBy: event.collectedBy,
      collectedAt: event.collectedAt.toISOString(),
      source: event.source,
      method: event.method
    };
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

function reviewMatchesProviderMessage(event: { workspaceId: string; entityId: string; metadata: unknown }, input: IncomingProviderMessage) {
  if (event.workspaceId !== input.workspaceId) return false;
  const metadata = metadataRecord(event.metadata);
  if (typeof metadata.provider === "string" && metadata.provider !== input.provider) return false;
  return event.entityId === input.providerMessageId;
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
}

function notificationTypeFromMetadata(metadata: Record<string, unknown>, fallback: "MAIL" | "PARCEL") {
  return metadata.notificationType === "PARCEL" ? "PARCEL" : metadata.notificationType === "MAIL" ? "MAIL" : fallback;
}
