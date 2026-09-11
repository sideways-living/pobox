import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const commit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(commit || "")) throw Error("Expected full commit SHA");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const files = {};
function walk(dir, relative = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) walk(join(dir, entry.name), name);
    else if (name !== "deployment.json") files[`/${name}`] = createHash("sha256").update(readFileSync(join(dir, entry.name))).digest("hex");
  }
}
walk("web/dist");
const manifest = JSON.stringify({ commit, version, builtAt: new Date().toISOString(), files }, null, 2);
writeFileSync("server/dist/deployment.json", manifest);
writeFileSync("web/dist/deployment.json", manifest);
console.log(`Stamped release ${commit} version ${version}`);
