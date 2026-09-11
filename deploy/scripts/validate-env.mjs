import { realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function validateEnvironment(env, root) {
  const errors = [];
  const require = name => { if (!env[name]?.trim()) errors.push(`Missing ${name}`); };
  for (const name of ["NODE_ENV", "PORT", "DATABASE_URL", "SESSION_SECRET", "ENCRYPTION_KEY", "APP_BASE_URL", "API_BASE_URL", "CORS_ORIGIN", "WEBAUTHN_RP_ID", "WEBAUTHN_ORIGIN"]) require(name);
  if (env.NODE_ENV !== "production") errors.push("NODE_ENV must be production");
  if ((env.POBOX_WATCH_STORAGE ?? env.MAILBOX_STORAGE) !== "prisma") errors.push("Production requires Prisma storage");
  if ((env.POBOX_WATCH_SEED_DEMO ?? env.MAILBOX_SEED_DEMO) !== "false") errors.push("Demo seeding must explicitly be false");
  if (!/^\d+$/.test(env.PORT || "") || Number(env.PORT) < 1 || Number(env.PORT) > 65535) errors.push("Invalid PORT");
  for (const name of ["SESSION_SECRET", "ENCRYPTION_KEY"]) {
    if ((env[name]?.length ?? 0) < 32 || /YOUR_|PASTE_|REPLACE_|CHANGE_ME|long-random/i.test(env[name] || "")) errors.push(`${name} must be a real secret of at least 32 characters`);
  }
  if (env.SESSION_SECRET === env.ENCRYPTION_KEY) errors.push("Session and encryption secrets must differ");
  try {
    const db = new URL(env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(db.protocol) || !db.username || !db.password || db.pathname === "/" || /YOUR_|PASTE_|REPLACE_/i.test(db.password)) throw Error();
  } catch { errors.push("Invalid PostgreSQL DATABASE_URL (value redacted)"); }
  try {
    const base = new URL(env.APP_BASE_URL);
    if (base.protocol !== "https:" || base.origin !== env.APP_BASE_URL || base.username || base.password) throw Error();
    for (const name of ["API_BASE_URL", "CORS_ORIGIN", "WEBAUTHN_ORIGIN"]) if (env[name] !== base.origin) errors.push(`${name} must match APP_BASE_URL for this same-origin deployment`);
    if (env.WEBAUTHN_RP_ID !== base.hostname) errors.push("WEBAUTHN_RP_ID must match the site hostname");
  } catch { errors.push("APP_BASE_URL must be a plain HTTPS origin"); }
  if (env.MAIL_POLL_ENABLED === "true") {
    if (env.MAIL_PROVIDER !== "gmail") errors.push("Enabled polling requires the supported Gmail provider");
    for (const name of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "MAIL_POLL_WORKSPACE_ID"]) require(name);
    if (!Number.isFinite(Number(env.MAIL_POLL_INTERVAL_MS || 1800000)) || Number(env.MAIL_POLL_INTERVAL_MS || 1800000) < 60000) errors.push("Invalid mail polling interval");
  } else if (env.MAIL_POLL_ENABLED && env.MAIL_POLL_ENABLED !== "false") errors.push("MAIL_POLL_ENABLED must be true or false");
  if (root && env.WEB_DIST_PATH && env.WEB_DIST_PATH !== `${root}/web/dist`) errors.push("WEB_DIST_PATH points outside the selected release");
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateEnvironment(process.env, process.env.RELEASE_DIR);
  if (Number(process.versions.node.split(".")[0]) < 22) errors.push("Node.js 22 or newer is required");
  const file = process.env.ENV_FILE;
  if (file && (statSync(realpathSync(file)).mode & 0o077)) errors.push(".env must not be accessible to group/other users; chmod 600 .env");
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log("Environment validated (secret values redacted).");
}
