import type { DashboardSnapshot } from "./types";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
export const workspaceId = "ws_company";

export async function login(email: string, password: string) {
  const response = await fetch(`${apiBase}/api/v1/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new Error(await errorMessage(response));
}

export async function loadDashboard(): Promise<DashboardSnapshot> {
  const response = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/dashboard`, { credentials: "include" });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function collectMailbox(mailboxId: string) {
  const response = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/mailboxes/${mailboxId}/collect`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "WEB" })
  });
  if (!response.ok) throw new Error(await errorMessage(response));
}

export async function simulateMail(mailboxNumber: string, duplicate = false) {
  const response = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/dev/simulate-mail`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mailboxNumber,
      providerMessageId: duplicate ? `fixed-duplicate-${mailboxNumber}` : undefined
    })
  });
  if (!response.ok) throw new Error(await errorMessage(response));
}

export function realtimeUrl() {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/v1/workspaces/${workspaceId}/realtime`;
  return url.toString();
}

async function errorMessage(response: Response) {
  try {
    const body = await response.json();
    return body.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
