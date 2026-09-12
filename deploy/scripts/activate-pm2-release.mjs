import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function activateRelease(root, name, run = (args) => execFileSync("pm2", args, { encoding: "utf8" })) {
  const configPath = resolve(root, "ecosystem.deploy.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const app = config.apps?.[0];
  if (config.apps?.length !== 1 || app.name !== name || app.cwd !== root || app.script !== `${root}/server/dist/src/index.js` || !existsSync(app.script)) {
    throw Error("Release PM2 configuration or built entry point is invalid; running process unchanged.");
  }
  const processes = JSON.parse(run(["jlist"]));
  // PM2 restart can retain the previous executable/cwd even with a new ecosystem file.
  if (processes.some(process => process.name === name)) run(["delete", name]);
  run(["start", configPath, "--only", name]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  activateRelease(process.env.RELEASE_DIR, process.env.PM2_NAME);
  console.log("PM2 started with the selected release configuration; readiness verification follows.");
}
