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
