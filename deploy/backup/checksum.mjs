import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [mode, file] = process.argv.slice(2);
const hash = createHash("sha256");
for await (const chunk of createReadStream(file)) hash.update(chunk);
const digest = hash.digest("hex");
if (mode === "write") writeFileSync(`${file}.sha256`, `${digest}\n`, { mode: 0o600 });
else if (mode !== "verify" || readFileSync(`${file}.sha256`, "utf8").trim() !== digest) throw Error("Backup checksum mismatch");
