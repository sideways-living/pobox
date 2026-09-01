import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

export interface Mailbox {
  id: string;
  name: string;
  boxNumber: string;
  active: boolean;
  mailWaiting: boolean;
  latestNotificationAt?: string;
  lastCollectedAt?: string;
  lastCollectedBy?: string;
}

export interface PostOffice {
  id: string;
  name: string;
  address: string;
  phone?: string;
  latitude: number;
  longitude: number;
  geofenceRadius: number;
  active: boolean;
  mailboxes: Mailbox[];
}

export interface DashboardSnapshot {
  workspace: { id: string; name: string };
  currentUser: { id: string; email: string; displayName: string; role: "ADMIN" | "MEMBER" };
  outstandingMailboxCount: number;
  postOffices: PostOffice[];
  history: Array<MailHistoryEvent | CollectionHistoryEvent>;
}

export interface MailHistoryEvent {
  id: string;
  workspaceId: string;
  mailboxId: string;
  provider: string;
  providerMessageId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  parserConfidence: number;
  parserRuleId?: string;
  processedAt: string;
}

export interface CollectionHistoryEvent {
  id: string;
  workspaceId: string;
  mailboxId: string;
  collectedBy: string;
  collectedAt: string;
  source: string;
  method: string;
}

export interface TeamMember {
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
  subject?: string;
  mailboxNumber?: string;
  confidence?: number;
  createdAt: string;
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
  phone?: string;
  latitude: number;
  longitude: number;
  geofenceRadius: number;
}

export interface PostOfficeLocationResult {
  sourceId: string;
  name: string;
  address: string;
  phone?: string;
  suburb?: string;
  postcode?: string;
  state?: string;
  latitude: number;
  longitude: number;
  hours?: string;
}

export interface CreateMailboxInput {
  postOfficeId: string;
  name: string;
  boxNumber: string;
}

export type LoginResult =
  | { ok: true; expiresAt: string; previousLoginAt?: string }
  | { ok: false; twoFactorRequired: true; challengeId: string; expiresAt: string; methods: Array<"totp" | "recovery_code"> };

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

export interface PasskeyRegistrationOptions {
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface PasskeyAuthenticationOptions {
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface AppChange {
  id: string;
  version: string;
  releasedAt: string;
  title: string;
  summary: string;
  audience: "ALL" | "ADMIN";
}

export interface AppChangesResponse {
  version: string;
  since?: string;
  changes: AppChange[];
}
