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
  history: Array<Record<string, string>>;
}

export interface TeamMember {
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
