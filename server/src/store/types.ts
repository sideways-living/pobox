import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from "@simplewebauthn/server";
import type { LctrPostOfficeLocation } from "../lctr/postOfficeLookup.js";
import type { PostOfficeDirectoryStatus } from "../lctr/postOfficeDirectory.js";
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
  notificationType?: "MAIL" | "PARCEL";
}

export interface TeamMemberSummary {
  id: string;
  email: string;
  displayName: string;
  role: "ADMIN" | "MEMBER";
  status: string;
  active: boolean;
}

export interface ReviewItem {
  id: string;
  providerMessageId: string;
  provider?: string;
  sender?: string;
  subject?: string;
  bodyPreview?: string;
  mailboxNumber?: string;
  postOfficeName?: string;
  notificationType?: "MAIL" | "PARCEL";
  confidence?: number;
  receivedAt?: string;
  createdAt: string;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  password: string;
  role: "ADMIN" | "MEMBER";
}

export interface UpdateUserInput {
  email?: string;
  displayName?: string;
  role?: "ADMIN" | "MEMBER";
}

export interface CreatePostOfficeInput {
  name: string;
  address: string;
  phone?: string;
  latitude: number;
  longitude: number;
  geofenceRadius: number;
}

export interface UpdatePostOfficeInput {
  name?: string;
  address?: string;
  phone?: string;
  latitude?: number;
  longitude?: number;
  geofenceRadius?: number;
}

export interface CreateMailboxInput {
  postOfficeId: string;
  name?: string;
  boxNumber: string;
}

export interface UpdateMailboxInput {
  postOfficeId?: string;
  boxNumber?: string;
}

export type LoginResult =
  | ({ kind: "session" } & Session)
  | { kind: "two_factor_required"; challengeId: string; expiresAt: string; methods: Array<"totp" | "recovery_code"> };

export interface SecurityStatus {
  passkeysAvailable: boolean;
  passkeyCount: number;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
}

export interface ConfirmTotpResult {
  recoveryCodes: string[];
}

export interface PasskeyRegistrationOptions {
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface PasskeyAuthenticationOptions {
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface AppStore {
  seedDemo(): Promise<void>;
  login(email: string, password: string): Promise<LoginResult>;
  verifySecondFactor(challengeId: string, code: string): Promise<Session>;
  getSession(sessionId?: string): Promise<Session>;
  securityStatus(session: Session): Promise<SecurityStatus>;
  beginTotpSetup(session: Session): Promise<TotpSetup>;
  confirmTotpSetup(session: Session, code: string): Promise<ConfirmTotpResult>;
  disableTotp(session: Session, code: string): Promise<void>;
  beginPasskeyRegistration(session: Session): Promise<PasskeyRegistrationOptions>;
  verifyPasskeyRegistration(session: Session, response: RegistrationResponseJSON, friendlyName?: string): Promise<SecurityStatus>;
  beginPasskeyAuthentication(email?: string): Promise<PasskeyAuthenticationOptions>;
  verifyPasskeyAuthentication(response: AuthenticationResponseJSON): Promise<LoginResult>;
  requireMember(session: Session, workspaceId: string, role?: "ADMIN"): Promise<WorkspaceMember>;
  dashboard(session: Session, workspaceId: string): Promise<DashboardSnapshot>;
  outstandingMailboxCount(workspaceId: string): Promise<number>;
  processIncomingMail(input: IncomingProviderMessage): Promise<IncomingMailResult>;
  collectMailbox(session: Session, workspaceId: string, mailboxId: string, source: CollectionSource): Promise<CollectionEvent>;
  listMembers(session: Session, workspaceId: string): Promise<TeamMemberSummary[]>;
  listReviewItems(session: Session, workspaceId: string): Promise<ReviewItem[]>;
  resolveReviewItem(session: Session, workspaceId: string, reviewItemId: string, mailboxId: string): Promise<IncomingMailResult>;
  dismissReviewItem(session: Session, workspaceId: string, reviewItemId: string): Promise<void>;
  searchPostOfficeLocations(session: Session, workspaceId: string, query: string): Promise<LctrPostOfficeLocation[]>;
  postOfficeDirectoryStatus(session: Session, workspaceId: string): Promise<PostOfficeDirectoryStatus>;
  syncPostOfficeDirectory(session: Session, workspaceId: string): Promise<PostOfficeDirectoryStatus>;
  createUser(session: Session, workspaceId: string, input: CreateUserInput): Promise<TeamMemberSummary>;
  updateUser(session: Session, workspaceId: string, userId: string, input: UpdateUserInput): Promise<TeamMemberSummary>;
  deleteUser(session: Session, workspaceId: string, userId: string): Promise<void>;
  createPostOffice(session: Session, workspaceId: string, input: CreatePostOfficeInput): Promise<PostOffice>;
  updatePostOffice(session: Session, workspaceId: string, postOfficeId: string, input: UpdatePostOfficeInput): Promise<PostOffice>;
  deletePostOffice(session: Session, workspaceId: string, postOfficeId: string): Promise<void>;
  createMailbox(session: Session, workspaceId: string, input: CreateMailboxInput): Promise<Mailbox>;
  updateMailbox(session: Session, workspaceId: string, mailboxId: string, input: UpdateMailboxInput): Promise<Mailbox>;
  deleteMailbox(session: Session, workspaceId: string, mailboxId: string): Promise<void>;
  inviteMember(session: Session, workspaceId: string, email: string, role: "ADMIN" | "MEMBER"): Promise<{
    invitationId: string;
    email: string;
    role: "ADMIN" | "MEMBER";
    status: string;
  }>;
}
