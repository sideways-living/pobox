import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
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
import type { AppStore, IncomingMailResult, IncomingProviderMessage } from "./types.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "./types.js";

export class PrismaStore implements AppStore {
  constructor(private readonly prisma = new PrismaClient()) {}

  async seedDemo() {
    if (process.env.NODE_ENV === "production" && process.env.MAILBOX_SEED_DEMO !== "true") return;
    const passwordHash = await argon2.hash("Password123!");
    await this.prisma.workspace.upsert({
      where: { id: "ws_company" },
      update: {},
      create: { id: "ws_company", name: "Company Mailboxes" }
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
      ["po_melbourne_gpo", "Melbourne GPO", "350 Bourke Street, Melbourne VIC", -37.8136, 144.9631],
      ["po_south_melbourne", "South Melbourne Post Office", "113-115 Clarendon Street, South Melbourne VIC", -37.8327, 144.9604],
      ["po_richmond", "Richmond Post Office", "382 Bridge Road, Richmond VIC", -37.8186, 145.0018]
    ] as const;
    for (const [id, name, address, latitude, longitude] of offices) {
      await this.prisma.postOffice.upsert({
        where: { id },
        update: { name, address, latitude, longitude, active: true },
        create: { id, workspaceId: "ws_company", name, address, latitude, longitude, geofenceRadius: 200, active: true }
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

  async login(email: string, password: string): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() }, include: { profile: true } });
    if (!user || !user.active || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedError("Invalid email or password.");
    }
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
    const session = await this.prisma.session.create({
      data: { id: randomBytes(32).toString("base64url"), userId: user.id, expiresAt }
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.toSession(session);
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
        where: { workspaceId },
        orderBy: { name: "asc" },
        include: { mailboxes: { orderBy: { boxNumber: "asc" } } }
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
        if (!mailbox) throw new NotFoundError("Mailbox not found.");
        const existing = await tx.collectionEvent.findFirst({ where: { mailboxId }, orderBy: { collectedAt: "desc" } });
        throw new ConflictError(
          existing ? `Already collected at ${existing.collectedAt.toISOString()} by ${existing.collectedBy}.` : "Mailbox is already clear."
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
      data: { workspaceId, actorUserId, eventType, entityType, entityId, metadata: metadata as Prisma.InputJsonObject }
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
