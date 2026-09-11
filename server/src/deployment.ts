import { readFileSync } from "node:fs";

// Read once at process start: changing a file cannot make an old process look new.
export const deploymentCommit: string | null = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../deployment.json", import.meta.url), "utf8"));
    return /^[a-f0-9]{40}$/.test(manifest.commit) ? manifest.commit : null;
  } catch { return null; }
})();
