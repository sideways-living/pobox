export const appVersion = "0.4.1";

export interface AppChange {
  id: string;
  version: string;
  releasedAt: string;
  title: string;
  summary: string;
  audience: "ALL" | "ADMIN";
}

export const appChanges: AppChange[] = [
  {
    id: "0.4.1-clear-logout",
    version: "0.4.1",
    releasedAt: "2026-09-01T12:00:00.000Z",
    title: "Clear logout button",
    summary:
      "The web app now shows your signed-in account in the top bar with a clear Log Out button, so ending a session no longer depends on a hidden API link.",
    audience: "ALL"
  },
  {
    id: "0.4.0-passkeys",
    version: "0.4.0",
    releasedAt: "2026-09-01T11:00:00.000Z",
    title: "Passkey sign-in",
    summary:
      "pobox.watch now supports adding a passkey from Settings and signing in with that passkey from the login screen on compatible browsers and devices.",
    audience: "ALL"
  },
  {
    id: "0.3.0-two-factor-auth",
    version: "0.3.0",
    releasedAt: "2026-09-01T10:00:00.000Z",
    title: "Authenticator app 2FA",
    summary:
      "You can now set up authenticator app two-factor authentication from Settings. Once enabled, pobox.watch asks for a one-time code or recovery code after your password.",
    audience: "ALL"
  },
  {
    id: "0.2.1-backend-branding",
    version: "0.2.1",
    releasedAt: "2026-08-31T15:30:00.000Z",
    title: "Backend branding updated",
    summary:
      "Backend package names, deployment templates, session cookie naming, and environment examples now use pobox.watch naming. Existing MAILBOX environment settings still work during the transition.",
    audience: "ALL"
  },
  {
    id: "0.2.0-version-notices",
    version: "0.2.0",
    releasedAt: "2026-08-31T15:00:00.000Z",
    title: "Changes since last login",
    summary:
      "pobox.watch now tracks your previous login time and shows a simple update notice after you sign in, so you can see what changed while you were away.",
    audience: "ALL"
  },
  {
    id: "0.2.0-branding",
    version: "0.2.0",
    releasedAt: "2026-08-31T15:00:00.000Z",
    title: "pobox.watch branding",
    summary:
      "The web, iPhone, and Mac apps now use the pobox.watch name, with PO box wording in the main screens and app metadata.",
    audience: "ALL"
  },
  {
    id: "0.2.0-admin-foundation",
    version: "0.2.0",
    releasedAt: "2026-08-31T15:00:00.000Z",
    title: "Admin setup tools",
    summary:
      "Admins can create real team users, post offices, and PO boxes from the Settings area while the product build-out continues.",
    audience: "ADMIN"
  },
  {
    id: "0.2.0-security-roadmap",
    version: "0.2.0",
    releasedAt: "2026-08-31T15:00:00.000Z",
    title: "Security build-out started",
    summary:
      "The database and configuration are prepared for passkeys and stronger sign-in controls. The next implementation step is the actual passkey and 2FA setup flow.",
    audience: "ALL"
  },
  {
    id: "0.2.0-map-links",
    version: "0.2.0",
    releasedAt: "2026-08-31T15:00:00.000Z",
    title: "Post office map links",
    summary:
      "Post office locations now include direct map links from the main web views, making collection trips easier to check.",
    audience: "ALL"
  }
];

export function changesSince(since?: string, role: "ADMIN" | "MEMBER" = "MEMBER") {
  const sinceTime = since ? new Date(since).getTime() : Number.NEGATIVE_INFINITY;
  return appChanges
    .filter((change) => change.audience === "ALL" || role === "ADMIN")
    .filter((change) => Number.isNaN(sinceTime) || new Date(change.releasedAt).getTime() > sinceTime)
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
}
