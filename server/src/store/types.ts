import type { CollectionEvent, CollectionSource, DashboardSnapshot, Mailbox, PostOffice, Session, WorkspaceMember } from "../domain.js";

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

export interface IncomingMailResult {
  kind: "processed" | "duplicate" | "needs_review";
  mailboxId?: string;
}

export interface TeamMemberSummary {
  id: string;
  email: string;
  displayName: string;
  role: "ADMIN" | "MEMBER";
  status: string;
  active: boolean;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  password: string;
  role: "ADMIN" | "MEMBER";
}

export interface CreatePostOfficeInput {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  geofenceRadius: number;
}

export interface CreateMailboxInput {
  postOfficeId: string;
  name: string;
  boxNumber: string;
}

export interface AppStore {
  seedDemo(): Promise<void>;
  login(email: string, password: string): Promise<Session>;
  getSession(sessionId?: string): Promise<Session>;
  requireMember(session: Session, workspaceId: string, role?: "ADMIN"): Promise<WorkspaceMember>;
  dashboard(session: Session, workspaceId: string): Promise<DashboardSnapshot>;
  outstandingMailboxCount(workspaceId: string): Promise<number>;
  processIncomingMail(input: IncomingProviderMessage): Promise<IncomingMailResult>;
  collectMailbox(session: Session, workspaceId: string, mailboxId: string, source: CollectionSource): Promise<CollectionEvent>;
  listMembers(session: Session, workspaceId: string): Promise<TeamMemberSummary[]>;
  createUser(session: Session, workspaceId: string, input: CreateUserInput): Promise<TeamMemberSummary>;
  createPostOffice(session: Session, workspaceId: string, input: CreatePostOfficeInput): Promise<PostOffice>;
  createMailbox(session: Session, workspaceId: string, input: CreateMailboxInput): Promise<Mailbox>;
  inviteMember(session: Session, workspaceId: string, email: string, role: "ADMIN" | "MEMBER"): Promise<{
    invitationId: string;
    email: string;
    role: "ADMIN" | "MEMBER";
    status: string;
  }>;
}
