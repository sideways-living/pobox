import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function verifyRelease(root, local, publicURL, expectedCommit) {
  const manifest = JSON.parse(readFileSync(`${root}/web/dist/deployment.json`, "utf8"));
  if (manifest.commit !== expectedCommit || !/^[a-f0-9]{40}$/.test(expectedCommit)) throw Error("Release manifest does not match intended commit");
  if (manifest.version !== JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version) throw Error("Manifest/package version mismatch");
  for (const base of [local, publicURL]) {
    const get = async path => {
      const response = await fetch(new URL(`${path}?deployment=${manifest.commit}`, base), { redirect: "error", signal: AbortSignal.timeout(10000), headers: { "Cache-Control": "no-cache" } });
      if (!response.ok) throw Error(`HTTP ${response.status} for ${path}`);
      return response;
    };
    const ready = await (await get("/api/ready")).json();
    if (!ready.ok || ready.storage !== "prisma" || ready.version !== manifest.version || ready.commit !== manifest.commit) throw Error("Readiness commit/version/storage mismatch");
    const html = await (await get("/")).text();
    if (createHash("sha256").update(html).digest("hex") !== manifest.files["/index.html"]) throw Error("Served HTML differs from the built release");
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(match => match[1]);
    if (!assets.some(path => path.endsWith(".js")) || !assets.some(path => path.endsWith(".css"))) throw Error("Missing built JS/CSS references");
    for (const path of assets) {
      if (!manifest.files[path]) throw Error("HTML references an asset outside its manifest");
      const response = await get(path);
      if (response.headers.get("content-type")?.includes("text/html")) throw Error("Asset returned HTML fallback");
      const hash = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
      if (hash !== manifest.files[path]) throw Error(`Asset bytes do not match release: ${path}`);
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyRelease(process.env.RELEASE_DIR, `http://127.0.0.1:${process.env.APP_PORT || 4175}`, process.env.SITE_URL || "https://pobox.watch", process.env.DEPLOY_COMMIT);
    console.log(`Verified DB readiness, commit ${result.commit}, version ${result.version}, HTML and JS/CSS bytes locally and publicly.`);
  } catch (error) { console.error(error.message); process.exit(1); }
}
