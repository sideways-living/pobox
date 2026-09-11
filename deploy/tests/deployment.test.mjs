import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { validateEnvironment } from "../scripts/validate-env.mjs";
import { verifyRelease } from "../scripts/verify-release.mjs";

const good = { NODE_ENV: "production", PORT: "4175", POBOX_WATCH_STORAGE: "prisma", POBOX_WATCH_SEED_DEMO: "false", DATABASE_URL: "postgresql://test:secret@localhost/test", SESSION_SECRET: "a".repeat(40), ENCRYPTION_KEY: "b".repeat(40), APP_BASE_URL: "https://pobox.watch", API_BASE_URL: "https://pobox.watch", CORS_ORIGIN: "https://pobox.watch", WEBAUTHN_RP_ID: "pobox.watch", WEBAUTHN_ORIGIN: "https://pobox.watch" };
test("environment validation rejects placeholders, wrong origins, demo storage and incomplete polling without printing secrets", () => {
  assert.deepEqual(validateEnvironment(good), []);
  for (const patch of [{ SESSION_SECRET: "PASTE_LONG_RANDOM_SECRET" }, { DATABASE_URL: "mysql://root:secret@localhost/db" }, { CORS_ORIGIN: "https://wrong.test" }, { POBOX_WATCH_SEED_DEMO: "true" }, { MAIL_POLL_ENABLED: "true" }, { PORT: "NaN" }]) assert.ok(validateEnvironment({ ...good, ...patch }).length);
  assert.ok(!validateEnvironment({ ...good, DATABASE_URL: "secret-not-a-url" }).join().includes("secret-not-a-url"));
});

test("verifier rejects same-version wrong commit, stale bytes, HTML fallback and database unready", async () => {
  const root = mkdtempSync(join(tmpdir(), "pobox-verify-"));
  const commit = "a".repeat(40), version = "0.13.9";
  const html = '<script src="/assets/main.js"></script><link href="/assets/main.css">';
  const content = { "/index.html": html, "/assets/main.js": "console.log(1)", "/assets/main.css": "body{}" };
  const files = Object.fromEntries(Object.entries(content).map(([p, value]) => [p, createHash("sha256").update(value).digest("hex")]));
  mkdirSync(join(root, "web/dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "web/dist/deployment.json"), JSON.stringify({ commit, version, files }));
  let fault = "";
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/api/ready") { res.statusCode = fault === "db" ? 503 : 200; res.end(JSON.stringify({ ok: true, storage: "prisma", commit: fault === "commit" ? "b".repeat(40) : commit, version })); return; }
    res.setHeader("Content-Type", fault === "html" ? "text/html" : "text/plain");
    res.end(fault === "bytes" && path.endsWith(".js") ? "stale" : content[path === "/" ? "/index.html" : path]);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await verifyRelease(root, base, base, commit);
    for (fault of ["db", "commit", "bytes", "html"]) await assert.rejects(verifyRelease(root, base, base, commit));
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["commit", "ci", "build", "backup", "migrate", "ready"]) test(`deploy preserves drift and stops safely after ${failure} failure`, () => {
  const root = mkdtempSync(join(tmpdir(), "pobox-deploy-contract-"));
  const origin = join(root, "origin"), app = join(root, "app"), bin = join(root, "bin"), log = join(root, "calls");
  mkdirSync(origin); mkdirSync(bin);
  const git = (...args) => execFileSync("git", args, { cwd: origin, stdio: "pipe" }).toString().trim();
  try {
    cpSync(resolve("deploy"), join(origin, "deploy"), { recursive: true });
    writeFileSync(join(origin, ".gitignore"), ".env\n");
    writeFileSync(join(origin, "package.json"), '{"version":"0.13.9"}');
    git("init", "-b", "main"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Fixture");
    const sha = git("rev-parse", "HEAD");
    execFileSync("git", ["clone", origin, app], { stdio: "pipe" });
    writeFileSync(join(app, "package.json"), '{"version":"local drift"}');
    writeFileSync(join(app, "ecosystem.config.cjs"), "local settings");
    writeFileSync(join(app, ".env"), Object.entries(good).map(([k, v]) => `${k}='${v}'`).join("\n"), { mode: 0o600 });
    const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\necho '${name}' \\"$@\\" >> '${log}'\n${body}\n`.replaceAll('\\"', '"'), { mode: 0o755 });
    stub("npm", `if [[ "${failure}" == ci && "$1" == ci ]] || [[ "${failure}" == build && "$*" == 'run build' ]] || [[ "${failure}" == migrate && "$*" == *prisma:migrate* ]]; then exit 9; fi\nif [[ "$*" == 'run build' ]]; then mkdir -p web/dist server/dist; echo '<script src="/assets/test.js"></script>' > web/dist/index.html; fi`);
    stub("pm2", failure === "ready" ? 'if [[ "$1" == jlist ]]; then echo "[]"; fi; exit 0' : "exit 8");
    stub("sleep", "exit 0");
    stub("pg_dump", failure === "backup" ? "exit 9" : 'while [[ "$#" -gt 0 ]]; do if [[ "$1" == --file ]]; then shift; echo archive > "$1"; fi; shift; done');
    stub("pg_restore", "exit 0");
    const result = spawnSync("bash", [join(app, "deploy/scripts/deploy-cloudpanel-pm2.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APP_DIR: app, RELEASES_DIR: join(root, "releases"), DEPLOY_COMMIT: failure === "commit" ? "f".repeat(40) : sha }, encoding: "utf8" });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(app, ".env"), "utf8").includes("DATABASE_URL"), true);
    const stash = execFileSync("git", ["stash", "list"], { cwd: app }).toString();
    assert.match(stash, /deployment drift/);
    assert.equal(execFileSync("git", ["show", "stash@{0}:package.json"], { cwd: app }).toString(), '{"version":"local drift"}');
    assert.equal(execFileSync("git", ["show", "stash@{0}^3:ecosystem.config.cjs"], { cwd: app }).toString(), "local settings");
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (failure === "ready") { assert.match(calls, /pm2 startOrRestart/); assert.doesNotMatch(calls, /pm2 save/); }
    else assert.ok(!calls.includes("pm2"));
    if (failure === "commit") assert.ok(!existsSync(log));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
