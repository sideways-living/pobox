export const appVersion = "0.10.0";

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
    id: "0.10.0-edit-delete-and-icons",
    version: "0.10.0",
    releasedAt: "2026-09-02T10:00:00.000Z",
    title: "Edit, delete, and app icons",
    summary:
      "Admins can now edit or delete users, post offices, and PO boxes with a confirmation before anything is removed. pobox.watch also has install icons for the website, iPhone, Mac, Android, and Windows.",
    audience: "ADMIN"
  },
  {
    id: "0.9.3-simpler-po-box-setup",
    version: "0.9.3",
    releasedAt: "2026-09-01T22:30:00.000Z",
    title: "Simpler PO Box setup",
    summary:
      "Adding a PO Box now only asks for the post office and PO Box number. pobox.watch automatically names the record from the number.",
    audience: "ADMIN"
  },
  {
    id: "0.9.2-post-office-autocomplete",
    version: "0.9.2",
    releasedAt: "2026-09-01T22:00:00.000Z",
    title: "Post office autocomplete",
    summary:
      "The Add Post Office search now shows suggestions as you type and ranks starts-with matches before locations where the typed words appear later in the name or address.",
    audience: "ADMIN"
  },
  {
    id: "0.9.1-post-office-directory-controls",
    version: "0.9.1",
    releasedAt: "2026-09-01T21:30:00.000Z",
    title: "Post office directory controls",
    summary:
      "Admins can now see the Australia Post directory import status, refresh it manually, and search without waiting for a background refresh to finish.",
    audience: "ADMIN"
  },
  {
    id: "0.9.0-synced-post-office-directory",
    version: "0.9.0",
    releasedAt: "2026-09-01T21:00:00.000Z",
    title: "Synced post office directory",
    summary:
      "pobox.watch now imports the Australia Post location catalogue from LCTR and refreshes it when the saved directory is older than a week, so post office setup searches local data first.",
    audience: "ADMIN"
  },
  {
    id: "0.8.0-lctr-post-office-lookup",
    version: "0.8.0",
    releasedAt: "2026-09-01T20:30:00.000Z",
    title: "Post office search from LCTR",
    summary:
      "Admins can search Australia Post locations by suburb, postcode, name, or address, then select a result to fill the post office address, phone number, and map location before saving.",
    audience: "ADMIN"
  },
  {
    id: "0.7.1-native-admin-setup",
    version: "0.7.1",
    releasedAt: "2026-09-01T19:30:00.000Z",
    title: "Native Apple admin setup",
    summary:
      "Admins can now create real users, post offices, and PO boxes from the Mac and iPhone apps as well as the web app.",
    audience: "ADMIN"
  },
  {
    id: "0.7.0-apple-maps-operations",
    version: "0.7.0",
    releasedAt: "2026-09-01T15:00:00.000Z",
    title: "Apple Maps and review queue",
    summary:
      "Post office location links now open in Apple Maps. The Map page has a clearer operations view, and parser exceptions now have a dedicated Needs Review queue.",
    audience: "ALL"
  },
  {
    id: "0.6.0-passkey-first-mandatory-security",
    version: "0.6.0",
    releasedAt: "2026-09-01T14:00:00.000Z",
    title: "Passkey-first mandatory security",
    summary:
      "The login screen now starts with passkey sign-in. Password sign-in is a fallback for setup, and users must add both a passkey and authenticator 2FA before entering the app.",
    audience: "ALL"
  },
  {
    id: "0.5.0-page-buildout",
    version: "0.5.0",
    releasedAt: "2026-09-01T13:00:00.000Z",
    title: "Full page layout build-out",
    summary:
      "Overview, PO Boxes, Map, History, Team, and Settings now have distinct operational layouts with clearer collection queues, filters, map views, activity summaries, and account controls.",
    audience: "ALL"
  },
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
