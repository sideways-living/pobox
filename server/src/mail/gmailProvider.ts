import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import type { MailProviderClient, ProviderUnreadMessage } from "./types.js";

function headerValue(message: gmail_v1.Schema$Message, name: string) {
  return message.payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(value?: string | null) {
  if (!value) return undefined;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function plainTextBody(part?: gmail_v1.Schema$MessagePart): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/plain") return decodeBase64Url(part.body?.data);
  for (const child of part.parts ?? []) {
    const text = plainTextBody(child);
    if (text) return text;
  }
  return undefined;
}

export interface GmailProviderConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  userId?: string;
  query?: string;
  maxResults?: number;
}

export class GmailProviderClient implements MailProviderClient {
  readonly providerName = "gmail";
  private readonly gmail: gmail_v1.Gmail;
  private readonly userId: string;
  private readonly query: string;
  private readonly maxResults: number;

  constructor(config: GmailProviderConfig) {
    const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    auth.setCredentials({ refresh_token: config.refreshToken });
    this.gmail = google.gmail({ version: "v1", auth });
    this.userId = config.userId ?? "me";
    this.query = config.query ?? "is:unread";
    this.maxResults = config.maxResults ?? 50;
  }

  async listUnreadMessages(): Promise<ProviderUnreadMessage[]> {
    const list = await this.gmail.users.messages.list({
      userId: this.userId,
      q: this.query,
      maxResults: this.maxResults
    });

    const messages = list.data.messages ?? [];
    const results: ProviderUnreadMessage[] = [];
    for (const item of messages) {
      if (!item.id) continue;
      const message = await this.gmail.users.messages.get({
        userId: this.userId,
        id: item.id,
        format: "full"
      });
      const data = message.data;
      const receivedAt = data.internalDate ? new Date(Number(data.internalDate)).toISOString() : undefined;
      results.push({
        providerMessageId: item.id,
        sender: headerValue(data, "from"),
        subject: headerValue(data, "subject"),
        bodyPreview: plainTextBody(data.payload) ?? data.snippet ?? undefined,
        receivedAt
      });
    }
    return results;
  }

  async markMessageRead(providerMessageId: string): Promise<void> {
    await this.gmail.users.messages.modify({
      userId: this.userId,
      id: providerMessageId,
      requestBody: { removeLabelIds: ["UNREAD"] }
    });
  }
}
