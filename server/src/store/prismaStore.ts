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
  TeamMemberSummary,
  UpdateMailboxInput,
  UpdatePostOfficeInput,
  UpdateUserInput
} from "./types.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "./types.js";

export class PrismaStore implements AppStore {
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
    if (!user || !user.active || !(await argon2.verify(user.passwordHash, password))) {
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
    const recovery = availableRecoveryCodes.find((candidate) => recoveryCodeMatches(code, candidate.codeHash));
    if (!validTotp && !recovery) throw new UnauthorizedError("Invalid two-factor code.");
    await this.prisma.$transaction([
      ...(recovery ? [this.prisma.recoveryCode.update({ where: { id: recovery.id }, data: { usedAt: new Date() } })] : []),
      this.prisma.authChallenge.delete({ where: { id: challenge.id } })
    ]);
    return this.createSession(challenge.userId, challenge.user.lastLoginAt?.toISOString());
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

  async beginTotpSetup(session: Session) {
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) throw new UnauthorizedError("Missing user.");
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { totpPendingSecretEncrypted: encryptSecret(secret) } });
    return { secret, otpauthUrl: totpUri(secret, user.email) };
  }

  async confirmTotpSetup(session: Session, code: string): Promise<ConfirmTotpResult> {
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user?.totpPendingSecretEncrypted) throw new ConflictError("Start 2FA setup before confirming.");
    const secret = decryptSecret(user.totpPendingSecretEncrypted);
    if (!verifyTotp(secret, code)) throw new UnauthorizedError("Invalid two-factor code.");
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          totpSecretEncrypted: user.totpPendingSecretEncrypted,
          totpPendingSecretEncrypted: null,
          totpEnabled: true,
          totpConfirmedAt: new Date()
        }
      }),
      ...recoveryCodes.map((recoveryCode) =>
        this.prisma.recoveryCode.create({ data: { userId: user.id, codeHash: hashRecoveryCode(recoveryCode) } })
      )
    ]);
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
      excludeCredentials: user.passkeyCredentials.map((credential) => ({
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
    const allowedCredentials = user?.passkeyCredentials.map((credential) => ({
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
    await this.prisma.$transaction([
      this.prisma.passkeyCredential.update({
        where: { id: credential.id },
        data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() }
      }),
      this.prisma.webAuthnChallenge.delete({ where: { id: challenge.id } })
    ]);
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

  private async createSession(userId: string, previousLoginAt?: string): Promise<Session> {
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
    const session = await this.prisma.session.create({
      data: { id: randomBytes(32).toString("base64url"), userId, expiresAt }
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
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt.getTime() < Date.now()) throw new UnauthorizedError("Session expired.");
    return this.toSession(session);
  }

  async requireMember(session: Session, workspaceId: string, role?: "ADMIN"): Promise<WorkspaceMember> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId: session.userId, status: "ACTIVE" }
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
    return this.prisma.mailbox.count({ where: { workspaceId, active: true, mailWaiting: true } });
  }

  async processIncomingMail(input: IncomingProviderMessage): Promise<IncomingMailResult> {
    const existing = await this.prisma.mailEvent.findUnique({
      where: {
        workspaceId_provider_providerMessageId: {
          workspaceId: input.workspaceId,
          provider: input.provider,
          providerMessageId: input.providerMessageId
        }
      }
    });
    if (existing) return { kind: "duplicate", mailboxId: existing.mailboxId };

    const boxes = await this.prisma.mailbox.findMany({ where: { workspaceId: input.workspaceId } });
    const parsed = parseMailNotification(input, boxes.map(this.toMailbox));
    if (!parsed.mailboxId || parsed.requiresReview) {
      await this.audit("system", input.workspaceId, "mail.needs_review", "mail_message", input.providerMessageId, {
        subject: input.subject,
        mailboxNumber: parsed.mailboxNumber,
        confidence: parsed.confidence
      });
      return { kind: "needs_review" };
    }

    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    try {
      await this.prisma.$transaction([
        this.prisma.mailEvent.create({
          data: {
            workspaceId: input.workspaceId,
            mailboxId: parsed.mailboxId,
            provider: input.provider,
            providerMessageId: input.providerMessageId,
            sender: input.sender,
            subject: input.subject,
            receivedAt,
            parserConfidence: parsed.confidence,
            parserRuleId: parsed.ruleId
          }
        }),
        this.prisma.mailbox.update({
          where: { id: parsed.mailboxId },
          data: { mailWaiting: true, latestNotificationAt: receivedAt }
        }),
        this.prisma.auditEvent.create({
          data: {
            workspaceId: input.workspaceId,
            actorUserId: undefined,
            eventType: "mail.detected",
            entityType: "mailbox",
            entityId: parsed.mailboxId,
            metadata: { provider: input.provider, providerMessageId: input.providerMessageId }
          }
        })
      ]);
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.prisma.mailEvent.findUnique({
          where: {
            workspaceId_provider_providerMessageId: {
              workspaceId: input.workspaceId,
              provider: input.provider,
              providerMessageId: input.providerMessageId
            }
          }
        });
        return { kind: "duplicate", mailboxId: duplicate?.mailboxId };
      }
      throw error;
    }
    return { kind: "processed", mailboxId: parsed.mailboxId };
  }

  async collectMailbox(session: Session, workspaceId: string, mailboxId: string, source: CollectionSource): Promise<CollectionEvent> {
    await this.requireMember(session, workspaceId);
    const event = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.mailbox.updateMany({
        where: { id: mailboxId, workspaceId, mailWaiting: true, active: true },
        data: { mailWaiting: false, lastCollectedAt: new Date(), lastCollectedBy: session.userId }
      });
      if (updated.count !== 1) {
        const mailbox = await tx.mailbox.findFirst({ where: { id: mailboxId, workspaceId } });
        if (!mailbox) throw new NotFoundError("PO box not found.");
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
      .map((member) => ({
        id: member.user.id,
        email: member.user.email,
        displayName: member.user.profile?.displayName ?? member.user.email,
        role: member.role,
        status: member.status,
        active: member.user.active
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async listReviewItems(session: Session, workspaceId: string): Promise<ReviewItem[]> {
    await this.requireMember(session, workspaceId);
    const events = await this.prisma.auditEvent.findMany({
      where: { workspaceId, eventType: "mail.needs_review" },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return events.map((event) => {
      const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
        ? event.metadata as Record<string, unknown>
        : {};
      return {
        id: event.id,
        providerMessageId: event.entityId,
        subject: typeof metadata.subject === "string" ? metadata.subject : undefined,
        mailboxNumber: typeof metadata.mailboxNumber === "string" ? metadata.mailboxNumber : undefined,
        confidence: typeof metadata.confidence === "number" ? metadata.confidence : undefined,
        createdAt: event.createdAt.toISOString()
      };
    });
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
    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash: await argon2.hash(input.password),
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
      await this.audit(session.userId, workspaceId, "member.created", "user", user.id, { email, role: input.role });
      return {
        id: user.id,
        email: user.email,
        displayName: user.profile?.displayName ?? user.email,
        role: user.memberships[0]?.role ?? input.role,
        status: user.memberships[0]?.status ?? "ACTIVE",
        active: user.active
      };
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError("User email already exists.");
      }
      throw error;
    }
  }

  async updateUser(session: Session, workspaceId: string, userId: string, input: UpdateUserInput): Promise<TeamMemberSummary> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      include: { user: { include: { profile: true } } }
    });
    if (!member) throw new NotFoundError("User not found.");

    if (session.userId === userId && input.role && input.role !== member.role) {
      throw new ConflictError("You cannot change your own role.");
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(input.email ? { email: input.email.toLowerCase() } : {}),
          ...(input.displayName ? { profile: { upsert: { update: { displayName: input.displayName }, create: { displayName: input.displayName } } } } : {}),
          ...(input.role ? { memberships: { update: { where: { workspaceId_userId: { workspaceId, userId } }, data: { role: input.role } } } } : {})
        },
        include: { profile: true, memberships: { where: { workspaceId } } }
      });
      await this.audit(session.userId, workspaceId, "member.updated", "user", userId, {
        email: input.email?.toLowerCase(),
        displayName: input.displayName,
        role: input.role
      });
      return {
        id: updated.id,
        email: updated.email,
        displayName: updated.profile?.displayName ?? updated.email,
        role: updated.memberships[0]?.role ?? member.role,
        status: updated.memberships[0]?.status ?? member.status,
        active: updated.active
      };
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError("User email already exists.");
      }
      throw error;
    }
  }

  async deleteUser(session: Session, workspaceId: string, userId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    if (session.userId === userId) throw new ConflictError("You cannot delete your own user.");
    const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId } });
    if (!member) throw new NotFoundError("User not found.");
    await this.prisma.$transaction([
      this.prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { status: "DISABLED" }
      }),
      this.prisma.user.update({ where: { id: userId }, data: { active: false } })
    ]);
    await this.audit(session.userId, workspaceId, "member.deleted", "user", userId, {});
  }

  async createPostOffice(session: Session, workspaceId: string, input: CreatePostOfficeInput): Promise<PostOffice> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office = await this.prisma.postOffice.create({
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
    await this.audit(session.userId, workspaceId, "post_office.created", "post_office", office.id, { name: office.name });
    return this.toPostOffice(office);
  }

  async updatePostOffice(session: Session, workspaceId: string, postOfficeId: string, input: UpdatePostOfficeInput): Promise<PostOffice> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office = await this.prisma.postOffice.findFirst({ where: { id: postOfficeId, workspaceId, active: true } });
    if (!office) throw new NotFoundError("Post office not found.");
    const updated = await this.prisma.postOffice.update({
      where: { id: postOfficeId },
      data: {
        name: input.name,
        address: input.address,
        phone: input.phone,
        latitude: input.latitude,
        longitude: input.longitude,
        geofenceRadius: input.geofenceRadius
      }
    });
    await this.audit(session.userId, workspaceId, "post_office.updated", "post_office", postOfficeId, { name: updated.name });
    return this.toPostOffice(updated);
  }

  async deletePostOffice(session: Session, workspaceId: string, postOfficeId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office = await this.prisma.postOffice.findFirst({ where: { id: postOfficeId, workspaceId, active: true } });
    if (!office) throw new NotFoundError("Post office not found.");
    await this.prisma.$transaction([
      this.prisma.mailbox.updateMany({ where: { workspaceId, postOfficeId }, data: { active: false, mailWaiting: false } }),
      this.prisma.postOffice.update({ where: { id: postOfficeId }, data: { active: false } })
    ]);
    await this.audit(session.userId, workspaceId, "post_office.deleted", "post_office", postOfficeId, { name: office.name });
  }

  async createMailbox(session: Session, workspaceId: string, input: CreateMailboxInput): Promise<Mailbox> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const office = await this.prisma.postOffice.findFirst({ where: { id: input.postOfficeId, workspaceId } });
    if (!office) throw new NotFoundError("Post office not found.");
    const existingForOffice = await this.prisma.mailbox.findFirst({ where: { workspaceId, postOfficeId: input.postOfficeId, active: true } });
    if (existingForOffice) throw new ConflictError("This post office already has a PO box.");
    const name = input.name?.trim() || `PO Box ${input.boxNumber.trim()}`;
    try {
      const mailbox = await this.prisma.mailbox.create({
        data: {
          workspaceId,
          postOfficeId: input.postOfficeId,
          name,
          boxNumber: input.boxNumber,
          active: true,
          mailWaiting: false
        }
      });
      await this.audit(session.userId, workspaceId, "mailbox.created", "mailbox", mailbox.id, { boxNumber: mailbox.boxNumber });
      return this.toMailbox(mailbox);
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError("PO box number already exists.");
      }
      throw error;
    }
  }

  async updateMailbox(session: Session, workspaceId: string, mailboxId: string, input: UpdateMailboxInput): Promise<Mailbox> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const mailbox = await this.prisma.mailbox.findFirst({ where: { id: mailboxId, workspaceId, active: true } });
    if (!mailbox) throw new NotFoundError("PO box not found.");
    if (input.postOfficeId) {
      const office = await this.prisma.postOffice.findFirst({ where: { id: input.postOfficeId, workspaceId, active: true } });
      if (!office) throw new NotFoundError("Post office not found.");
      const existingForOffice = await this.prisma.mailbox.findFirst({
        where: { workspaceId, postOfficeId: input.postOfficeId, active: true, NOT: { id: mailboxId } }
      });
      if (existingForOffice) throw new ConflictError("This post office already has a PO box.");
    }
    const boxNumber = input.boxNumber?.trim();
    try {
      const updated = await this.prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
          postOfficeId: input.postOfficeId,
          boxNumber,
          name: boxNumber ? `PO Box ${boxNumber}` : undefined
        }
      });
      await this.audit(session.userId, workspaceId, "mailbox.updated", "mailbox", mailboxId, { boxNumber: updated.boxNumber });
      return this.toMailbox(updated);
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError("PO box number already exists.");
      }
      throw error;
    }
  }

  async deleteMailbox(session: Session, workspaceId: string, mailboxId: string): Promise<void> {
    await this.requireMember(session, workspaceId, "ADMIN");
    const mailbox = await this.prisma.mailbox.findFirst({ where: { id: mailboxId, workspaceId, active: true } });
    if (!mailbox) throw new NotFoundError("PO box not found.");
    await this.prisma.mailbox.update({ where: { id: mailboxId }, data: { active: false, mailWaiting: false } });
    await this.audit(session.userId, workspaceId, "mailbox.deleted", "mailbox", mailboxId, { boxNumber: mailbox.boxNumber });
  }

  async inviteMember(session: Session, workspaceId: string, email: string, role: "ADMIN" | "MEMBER") {
    await this.requireMember(session, workspaceId, "ADMIN");
    const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    const invitation = await this.prisma.invitation.create({
      data: {
        workspaceId,
        email: email.toLowerCase(),
        role,
        tokenHash,
        invitedBy: session.userId,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
      }
    });
    await this.audit(session.userId, workspaceId, "member.invited", "workspace", workspaceId, { email, role });
    return { invitationId: invitation.id, email, role, status: "PENDING_EMAIL_DELIVERY" };
  }

  private async audit(actorUserId: string | undefined, workspaceId: string, eventType: string, entityType: string, entityId: string, metadata: Record<string, unknown>): Promise<AuditEvent> {
    const event = await this.prisma.auditEvent.create({
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

  private toSession(session: { id: string; userId: string; expiresAt: Date }): Session {
    return { id: session.id, userId: session.userId, expiresAt: session.expiresAt.toISOString() };
  }

  private toPostOffice(office: {
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
    latestNotificationAt: Date | null;
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
      latestNotificationAt: box.latestNotificationAt?.toISOString(),
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
