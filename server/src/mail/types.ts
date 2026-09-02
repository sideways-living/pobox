import type { AppStore, IncomingMailResult } from "../store/types.js";

export interface ProviderUnreadMessage {
  providerMessageId: string;
  sender: string;
  subject: string;
  bodyPreview?: string;
  receivedAt?: string;
}

export interface MailProviderClient {
  providerName: string;
  listUnreadMessages(): Promise<ProviderUnreadMessage[]>;
  markMessageRead(providerMessageId: string): Promise<void>;
}

export interface MailPollerOptions {
  workspaceId: string;
  intervalMs: number;
  logger?: Pick<Console, "error" | "info" | "warn">;
}

export interface MailPollSummary {
  scanned: number;
  processed: number;
  duplicates: number;
  needsReview: number;
  markedRead: number;
}

export type MailProcessResult = IncomingMailResult["kind"];

export interface MailPollerDependencies {
  store: Pick<AppStore, "processIncomingMail">;
  provider: MailProviderClient;
}
