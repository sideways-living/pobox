import type { AppChangesResponse, CreateMailboxInput, CreatePostOfficeInput, CreateUserInput, DashboardSnapshot, LoginResult, SecurityStatus, TeamMember, TotpSetup } from "./types";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
export const workspaceId = "ws_company";

export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch(`${apiBase}/api/v1/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function verifySecondFactor(challengeId: string, code: string): Promise<LoginResult> {
  const response = await fetch(`${apiBase}/api/v1/auth/2fa/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId, code })
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function loadSecurityStatus(): Promise<SecurityStatus> {
  const response = await fetch(`${apiBase}/api/v1/auth/security`, { credentials: "include" });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function beginTotpSetup(): Promise<TotpSetup> {
  const response = await fetch(`${apiBase}/api/v1/auth/2fa/setup`, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function confirmTotpSetup(code: string): Promise<{ recoveryCodes: string[] }> {
  const response = await fetch(`${apiBase}/api/v1/auth/2fa/confirm`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function disableTotp(code: string): Promise<void> {
  const response = await fetch(`${apiBase}/api/v1/auth/2fa/disable`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  if (!response.ok) throw new Error(await errorMessage(response));
}

export async function loadDashboard(): Promise<DashboardSnapshot> {
  const response = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/dashboard`, { credentials: "include" });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function loadAppChanges(since?: string): Promise<AppChangesResponse> {
  const url = new URL(`${apiBase}/api/v1/workspaces/${workspaceId}/app/changes`);
  if (since) url.searchParams.set("since", since);
  const response = await fetch(url, { credentials: "include" });
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

export async function loadMembers(): Promise<TeamMember[]> {
  const response = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/team/members`, { credentials: "include" });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function createUser(input: CreateUserInput): Promise<TeamMember> {
  const response = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/team/users`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function createPostOffice(input: CreatePostOfficeInput) {
  const response = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/post-offices`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function createMailbox(input: CreateMailboxInput) {
  const response = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/mailboxes`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
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
