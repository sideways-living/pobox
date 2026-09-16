import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../src/api/server.js";
import { MemoryStore } from "../src/store/memoryStore.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalWebDistPath = process.env.WEB_DIST_PATH;
let temporaryDirectory: string | undefined;

afterEach(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalWebDistPath === undefined) delete process.env.WEB_DIST_PATH;
  else process.env.WEB_DIST_PATH = originalWebDistPath;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("public web pages", () => {
  it("serves the dedicated privacy document at Google's trailing-slash URL", async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pobox-public-pages-"));
    await mkdir(path.join(temporaryDirectory, "docs/privacy"), { recursive: true });
    await writeFile(path.join(temporaryDirectory, "index.html"), "<h1>Public homepage</h1>");
    await writeFile(path.join(temporaryDirectory, "docs/privacy/index.html"), "<h1>Privacy Policy</h1><p>Google user data</p>");
    process.env.NODE_ENV = "production";
    process.env.WEB_DIST_PATH = temporaryDirectory;

    const app = await buildServer(new MemoryStore());
    const privacy = await app.inject({ method: "GET", url: "/docs/privacy/" });
    const homepage = await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(privacy.statusCode).toBe(200);
    expect(privacy.headers["content-type"]).toContain("text/html");
    expect(privacy.body).toContain("Privacy Policy");
    expect(homepage.body).toContain("Public homepage");
  });
});
