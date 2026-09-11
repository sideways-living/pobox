import { spawn } from "node:child_process";
// Requires the production web build, Chrome and Playwright (or PLAYWRIGHT_MODULE).
for (const name of ["review", "management", "multiuser", "maps-releases", "security"]) {
  const security = name === "security";
  const fixture = spawn(process.execPath, ["--import", "tsx", `server/tests/support/${security ? "security" : "review"}BrowserServer.ts`], { env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  try {
    const sessions = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Browser fixture startup timed out")), 15000);
      fixture.once("exit", code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}`)); });
      fixture.stdout.on("data", data => {
        output += data;
        const admin = output.match(/REVIEW_SESSION=(\S+)/)?.[1], member = output.match(/MEMBER_SESSION=(\S+)/)?.[1];
        if ((security && output.includes("Server listening")) || (admin && member)) { clearTimeout(timer); resolve({ REVIEW_SESSION: admin, MEMBER_SESSION: member }); }
        if (output.length > 20000) output = output.slice(-10000);
      });
    });
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`scripts/verify-${name}-browser.mjs`], { env: { ...process.env, ...sessions, MAPKIT_MISSING: "1" }, stdio: "inherit" });
      const timer = setTimeout(() => { child.kill(); reject(Error(`${name} browser timeout`)); }, 120000);
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`${name} browser failed (${code})`)); });
    });
  } finally {
    if (fixture.exitCode === null) await new Promise(resolve => { fixture.once("exit", resolve); fixture.kill(); });
  }
}
