import argon2 from "argon2";
import { nanoid } from "nanoid";
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

export class ForbiddenError extends Error {}
export class UnauthorizedError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export interface IncomingProviderMessage {
  workspaceId: string;
  provider: string;
  providerMessageId: string;
  sender: string;
  subject: string;
  bodyPreview?: string;
  receivedAt?: string;
}

export class MemoryStore {
  users = new Map<string, User>();
  workspaces = new Map<string, Workspace>();
  members = new Map<string, WorkspaceMember>();
  postOffices = new Map<string, PostOffice>();
  mailboxes = new Map<string, Mailbox>();
  mailEvents = new Map<string, MailEvent>();
  collectionEvents = new Map<string, CollectionEvent>();
  auditEvents = new Map<string, AuditEvent>();
  sessions = new Map<string, Session>();

  async seedDemo() {
    if (this.users.size > 0) return;
    const workspace: Workspace = { id: "ws_company", name: "Company Mailboxes" };
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

  async login(email: string, password: string): Promise<Session> {
    const user = [...this.users.values()].find((candidate) => candidate.email.toLowerCase() === email.toLowerCase());
    if (!user || !user.active || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedError("Invalid email or password.");
    }
    const session: Session = {
      id: nanoid(32),
      userId: user.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId?: string): Session {
    if (!sessionId) throw new UnauthorizedError("Missing session.");
    const session = this.sessions.get(sessionId);
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
      throw new UnauthorizedError("Session expired.");
    }
    return session;
  }

  requireMember(session: Session, workspaceId: string, role?: "ADMIN"): WorkspaceMember {
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

  dashboard(session: Session, workspaceId: string): DashboardSnapshot {
    const member = this.requireMember(session, workspaceId);
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
      outstandingMailboxCount: this.outstandingMailboxCount(workspaceId),
      postOffices,
      history
    };
  }

  outstandingMailboxCount(workspaceId: string): number {
    return [...this.mailboxes.values()].filter((box) => box.workspaceId === workspaceId && box.active && box.mailWaiting).length;
  }

  processIncomingMail(input: IncomingProviderMessage): { kind: "processed" | "duplicate" | "needs_review"; mailboxId?: string } {
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
    if (!mailbox) throw new NotFoundError("Mailbox not found.");
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

  collectMailbox(session: Session, workspaceId: string, mailboxId: string, source: CollectionSource): CollectionEvent {
    this.requireMember(session, workspaceId);
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox || mailbox.workspaceId !== workspaceId) throw new NotFoundError("Mailbox not found.");
    if (!mailbox.mailWaiting) {
      const existing = [...this.collectionEvents.values()]
        .filter((event) => event.mailboxId === mailboxId)
        .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
      throw new ConflictError(
        existing ? `Already collected at ${existing.collectedAt} by ${existing.collectedBy}.` : "Mailbox is already clear."
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

  inviteMember(session: Session, workspaceId: string, email: string, role: "ADMIN" | "MEMBER") {
    this.requireMember(session, workspaceId, "ADMIN");
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

export const store = new MemoryStore();
