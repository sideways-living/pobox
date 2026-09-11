import { writeFileSync } from "node:fs";
const cwd = process.env.RELEASE_DIR;
if (!cwd || !process.env.PM2_NAME) throw Error("Missing release directory or PM2 name");
writeFileSync(`${cwd}/ecosystem.deploy.json`, JSON.stringify({ apps: [{
  name: process.env.PM2_NAME, cwd, script: `${cwd}/server/dist/src/index.js`,
  interpreter: process.execPath, instances: 1, exec_mode: "fork", env: process.env
}] }, null, 2), { mode: 0o600 });
