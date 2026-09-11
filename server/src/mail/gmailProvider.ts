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

function htmlTextBody(part?: gmail_v1.Schema$MessagePart): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/html") {
    const html = decodeBase64Url(part.body?.data);
    return html ? htmlToSearchableText(html) : undefined;
  }
  for (const child of part.parts ?? []) {
    const text = htmlTextBody(child);
    if (text) return text;
  }
  return undefined;
}

function htmlToSearchableText(html: string) {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/(?:p|div|tr|td|th|table)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
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
    if (!Number.isInteger(this.maxResults) || this.maxResults < 1 || this.maxResults > 500) {
      throw new Error("MAIL_POLL_MAX_RESULTS must be an integer between 1 and 500 (Gmail page size).");
    }
  }

  async listUnreadMessages(): Promise<ProviderUnreadMessage[]> {
    const messages = new Map<string, gmail_v1.Schema$Message>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    // Finish listing before the poller removes UNREAD, so pagination is not
    // shifted by our own acknowledgements. Review items may remain unread.
    do {
      const list = await this.gmail.users.messages.list({
        userId: this.userId,
        q: this.query,
        maxResults: this.maxResults,
        pageToken
      });
      for (const item of list.data.messages ?? []) {
        if (item.id) messages.set(item.id, item);
      }
      pageToken = list.data.nextPageToken || undefined;
      if (pageToken && seenPageTokens.has(pageToken)) throw new Error("Gmail returned a repeated page token.");
      if (pageToken) seenPageTokens.add(pageToken);
    } while (pageToken);

    const results: ProviderUnreadMessage[] = [];
    for (const item of messages.values()) {
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
        providerThreadId: data.threadId ?? item.threadId ?? undefined,
        sender: headerValue(data, "from"),
        subject: headerValue(data, "subject"),
        bodyPreview: plainTextBody(data.payload) ?? htmlTextBody(data.payload) ?? data.snippet ?? undefined,
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
