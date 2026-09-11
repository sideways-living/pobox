import { createRequire } from "node:module";
const { PrismaClient } = createRequire(new URL("../../server/package.json", import.meta.url))("@prisma/client");
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const sourceURL = process.env.RECOVERY_DATABASE_URL, targetURL = process.env.RESTORE_DATABASE_URL;
for (const value of [sourceURL, targetURL]) {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw Error("Recovery drill only accepts loopback databases ending _test");
}
if (sourceURL === targetURL) throw Error("Use distinct source and empty restore databases");
const source = new PrismaClient({ datasourceUrl: sourceURL }), target = new PrismaClient({ datasourceUrl: targetURL });
const root = mkdtempSync(join(tmpdir(), "pobox-recovery-drill-"));
const origin = join(root, "origin"), app = join(root, "app"), releases = join(root, "releases");
const env = { ...process.env, PM2_HOME: join(root, "pm2"), APP_DIR: app, RELEASES_DIR: releases, APP_PORT: "4188", SITE_URL: "http://127.0.0.1:4188", DATABASE_URL: sourceURL };
const run = (tool, args, options = {}) => execFileSync(tool, args, { cwd: app, env, encoding: "utf8", stdio: "pipe", ...options });
let workspace;
try {
  workspace = await source.workspace.create({ data: { name: "Recovery drill" } });
  const office = await source.postOffice.create({ data: { workspaceId: workspace.id, name: "Retained custom office", address: "181 Clarendon St", latitude: -37.83, longitude: 144.96 } });
  const box = await source.mailbox.create({ data: { workspaceId: workspace.id, postOfficeId: office.id, name: "PO Box 3020", boxNumber: "3020", mailWaiting: true, parcelWaiting: true } });
  mkdirSync(origin);
  // Snapshot only project files, including this turn's edits, never .env or unrelated drift.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).filter(p => p !== "server/prisma/schema 2.prisma");
  for (const file of files) { mkdirSync(dirname(join(origin, file)), { recursive: true }); cpSync(resolve(file), join(origin, file)); }
  const git = (...args) => execFileSync("git", args, { cwd: origin, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("add", "."); git("-c", "user.name=Drill", "-c", "user.email=drill@example.test", "commit", "-m", "Isolated recovery fixture");
  const commit = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", origin, app], { stdio: "pipe" });
  const config = { NODE_ENV: "production", PORT: "4188", POBOX_WATCH_STORAGE: "prisma", POBOX_WATCH_SEED_DEMO: "false", DATABASE_URL: sourceURL, SESSION_SECRET: "a".repeat(48), ENCRYPTION_KEY: "b".repeat(48), APP_BASE_URL: "https://pobox.watch", API_BASE_URL: "https://pobox.watch", CORS_ORIGIN: "https://pobox.watch", WEBAUTHN_RP_ID: "pobox.watch", WEBAUTHN_ORIGIN: "https://pobox.watch", MAIL_POLL_ENABLED: "false" };
  writeFileSync(join(app, ".env"), Object.entries(config).map(([k,v]) => `${k}='${v}'`).join("\n"), { mode: 0o600 });
  writeFileSync(join(app, "ecosystem.config.cjs"), "// retained drift\n");
  const output = run("bash", ["deploy/scripts/deploy-cloudpanel-pm2.sh"], { env: { ...env, DEPLOY_COMMIT: commit }, timeout: 240000, maxBuffer: 10 * 1024 * 1024 });
  assert.match(output, /Deployment verified/);
  const release = readFileSync(join(releases, "last-successful-release"), "utf8").trim();
  const ready = await (await fetch("http://127.0.0.1:4188/api/ready")).json();
  assert.equal(ready.commit, commit);
  assert.equal(ready.ok, true);
  const backup = readdirSync(join(releases, "backups")).find(name => name.endsWith(".dump"));
  assert.ok(backup);
  const dump = join(releases, "backups", backup);
  await source.mailbox.update({ where: { id: box.id }, data: { mailWaiting: false, parcelWaiting: false } });
  const restoreEnv = { ...env, DATABASE_URL: targetURL, RESTORE_CONFIRM: new URL(targetURL).pathname.slice(1) };
  run("bash", ["deploy/backup/restore-db.sh", dump], { env: restoreEnv });
  assert.deepEqual(await target.mailbox.findUnique({ where: { id: box.id }, select: { mailWaiting: true, parcelWaiting: true } }), { mailWaiting: true, parcelWaiting: true });
  assert.equal((await target.postOffice.findUnique({ where: { id: office.id } })).name, "Retained custom office");
  run("npm", ["run", "prisma:migrate", "--workspace", "server"], { cwd: release, env: restoreEnv });
  const restoredAppEnv = { ...env, ...config, DATABASE_URL: targetURL, RELEASE_DIR: release, PM2_NAME: "pobox-watch-api", WEB_DIST_PATH: `${release}/web/dist` };
  run("node", ["deploy/scripts/write-pm2-config.mjs"], { cwd: release, env: restoredAppEnv });
  run("pm2", ["startOrRestart", `${release}/ecosystem.deploy.json`, "--only", "pobox-watch-api", "--update-env"], { env: restoredAppEnv });
  let restoredReady = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { const result = await (await fetch("http://127.0.0.1:4188/api/ready")).json(); if (result.ok && result.commit === commit) { restoredReady = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(restoredReady, "Restored app did not become ready");
  const retry = spawnSync("bash", ["deploy/backup/restore-db.sh", dump], { cwd: app, env: restoreEnv, encoding: "utf8" });
  assert.notEqual(retry.status, 0); assert.match(retry.stderr, /empty destination/);
  writeFileSync(`${dump}.sha256`, "invalid\n");
  const corrupt = spawnSync("bash", ["deploy/backup/restore-db.sh", dump], { cwd: app, env: restoreEnv, encoding: "utf8" });
  assert.notEqual(corrupt.status, 0); assert.match(corrupt.stderr, /checksum mismatch/);
  console.log(`PASS: actual Git fetch/stash, npm ci, Prisma generate/migrate, build, isolated PM2, database readiness and asset bytes; backup restored mail/parcel/custom fields, repeat/corrupt restores refused. Fixture commit ${commit}.`);
  console.log(`No public VPS was contacted. Temporary artifacts ${process.env.KEEP_RECOVERY_DRILL === "true" ? `retained at ${root}` : "are removed after the drill"}.`);
} finally {
  spawnSync("pm2", ["kill"], { env, stdio: "ignore" });
  if (workspace) {
    for (const db of [source, target]) {
      await db.mailbox.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {});
      await db.postOffice.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {});
      await db.workspace.deleteMany({ where: { id: workspace.id } }).catch(() => {});
    }
  }
  await source.$disconnect(); await target.$disconnect();
  if (process.env.KEEP_RECOVERY_DRILL !== "true") rmSync(root, { recursive: true, force: true });
}
