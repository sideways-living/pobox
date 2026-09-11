import { spawnSync } from "node:child_process";
const url = new URL(process.env.DATABASE_URL);
if (!["postgres:", "postgresql:"].includes(url.protocol)) throw Error("PostgreSQL URL required");
// Keep credentials out of process arguments and logs.
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: "10" };
if (url.searchParams.has("sslmode")) env.PGSSLMODE = url.searchParams.get("sslmode");
const [tool, ...args] = process.argv.slice(2);
if (!["pg_dump", "pg_restore", "psql"].includes(tool)) throw Error("Unsupported database tool");
if (tool === "pg_restore") args.unshift("--dbname", env.PGDATABASE);
const result = spawnSync(tool, args, { env, stdio: "inherit" });
if (result.error) console.error("Database tool could not start");
process.exit(result.status ?? 1);
