export type Role = "ADMIN" | "MEMBER";
export type MemberStatus = "INVITED" | "ACTIVE" | "DISABLED";
export type MailboxStatusText = "Mail Waiting" | "Clear" | "Needs Review" | "Disabled";
export type CollectionSource = "IPHONE" | "MACOS" | "WEB" | "ADMIN" | "NOTIFICATION";

export interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  emailVerified: boolean;
  active: boolean;
  lastLoginAt?: string;
  totpEnabled?: boolean;
  totpSecretEncrypted?: string;
  totpPendingSecretEncrypted?: string;
  totpConfirmedAt?: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: Role;
  status: MemberStatus;
}

export interface PostOffice {
  id: string;
  workspaceId: string;
  name: string;
  address: string;
  phone?: string;
  latitude: number;
  longitude: number;
  geofenceRadius: number;
  active: boolean;
}

export interface Mailbox {
  id: string;
  workspaceId: string;
  postOfficeId: string;
  name: string;
  boxNumber: string;
  active: boolean;
  mailWaiting: boolean;
  parcelWaiting: boolean;
  latestNotificationAt?: string;
  latestParcelNotificationAt?: string;
  lastCollectedAt?: string;
  lastCollectedBy?: string;
  updatedAt: string;
}

export interface MailEvent {
  id: string;
  workspaceId: string;
  mailboxId: string;
  provider: string;
  providerMessageId: string;
  sender: string;
  subject: string;
  notificationType: "MAIL" | "PARCEL";
  receivedAt: string;
  parserConfidence: number;
  parserRuleId?: string;
  processedAt: string;
}

export interface CollectionEvent {
  id: string;
  workspaceId: string;
  mailboxId: string;
  collectedBy: string;
  collectedAt: string;
  source: CollectionSource;
  method: string;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorUserId?: string;
  eventType: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  previousLoginAt?: string;
}

export interface AuthChallenge {
  id: string;
  userId: string;
  expiresAt: string;
}

export interface ParsedMailNotification {
  mailboxNumber?: string;
  mailboxId?: string;
  postOfficeName?: string;
  notificationType: "MAIL" | "PARCEL";
  confidence: number;
  requiresReview: boolean;
  ruleId?: string;
}

export interface DashboardSnapshot {
  workspace: Workspace;
  currentUser: Pick<User, "id" | "email" | "displayName"> & { role: Role };
  outstandingMailboxCount: number;
  postOffices: Array<PostOffice & { mailboxes: Mailbox[] }>;
  history: Array<MailEvent | CollectionEvent>;
}
