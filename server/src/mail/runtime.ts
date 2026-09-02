import { GmailProviderClient } from "./gmailProvider.js";
import { MailPoller } from "./poller.js";
import type { MailProviderClient } from "./types.js";
import type { AppStore } from "../store/types.js";

function env(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function createConfiguredMailProvider(): MailProviderClient | undefined {
  const provider = env("MAIL_PROVIDER") ?? "mock";
  if (provider !== "gmail") return undefined;

  const clientId = env("GMAIL_CLIENT_ID") ?? env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GMAIL_CLIENT_SECRET") ?? env("GOOGLE_CLIENT_SECRET");
  const refreshToken = env("GMAIL_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("MAIL_PROVIDER=gmail requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.");
  }

  return new GmailProviderClient({
    clientId,
    clientSecret,
    refreshToken,
    userId: env("GMAIL_USER_ID") ?? "me",
    query: env("GMAIL_SEARCH_QUERY") ?? "is:unread",
    maxResults: Number(env("MAIL_POLL_MAX_RESULTS") ?? 50)
  });
}

export function startConfiguredMailPoller(store: AppStore) {
  const enabled = (env("MAIL_POLL_ENABLED") ?? "false").toLowerCase() === "true";
  if (!enabled) return undefined;
  const provider = createConfiguredMailProvider();
  if (!provider) return undefined;

  const workspaceId = env("MAIL_POLL_WORKSPACE_ID") ?? env("POBOX_WATCH_WORKSPACE_ID") ?? "ws_company";
  const intervalMs = Number(env("MAIL_POLL_INTERVAL_MS") ?? 30 * 60 * 1000);
  const poller = new MailPoller({ store, provider }, { workspaceId, intervalMs, logger: console });
  poller.start();
  return poller;
}
