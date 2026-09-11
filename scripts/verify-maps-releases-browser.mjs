import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
if (!process.env.REVIEW_SESSION || !process.env.MEMBER_SESSION) throw new Error("Start reviewBrowserServer first.");
const missing = process.env.MAPKIT_MISSING === "1";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const admin of [true, false]) {
    const context = await browser.newContext({ viewport: { width: admin ? 1440 : 390, height: 900 } });
    await context.addCookies([{ name: "pobox_watch_session", value: admin ? process.env.REVIEW_SESSION : process.env.MEMBER_SESSION, url: "http://127.0.0.1:4189" }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://cdn.apple-mapkit.com/**", route => route.fulfill({ contentType: "application/javascript", body: "/* isolated MapKit transport fixture */" }));
    // Only Apple transport is simulated. App HTTP, CSP, releases and UI are real.
    await page.addInitScript(() => {
      const kit = new EventTarget();
      kit.load = async () => kit;
      kit.Coordinate = class { constructor(latitude, longitude) { Object.assign(this, { latitude, longitude }); } };
      kit.CoordinateSpan = class {};
      kit.CoordinateRegion = class { constructor(center) { this.center = center; } };
      kit.MarkerAnnotation = class { constructor(coordinate, options) { Object.assign(this, { coordinate, ...options }); } };
      kit.Map = class {
        constructor(element) { this.element = element; window.mapCreations = (window.mapCreations || 0) + 1; }
        addAnnotations(items) { window.mapAnnotations = items; }
        destroy() {}
      };
      window.mapkit = kit;
    });
    await page.route("**/auth/login", route => route.fulfill({ json: { ok: true } }));
    const base = "http://127.0.0.1:4189/api/v1/workspaces/ws_company/app/changes";
    const before = await (await context.request.get(base)).json();
    await page.goto("http://127.0.0.1:4189");
    await page.getByRole("button", { name: "Use Password to Set Up Security" }).click();
    await page.getByLabel("Email", { exact: true }).fill(admin ? "daniel@example.com" : "john@example.com");
    await page.getByLabel("Password", { exact: true }).fill("fixture");
    await page.getByRole("button", { name: "Continue with Password" }).click();
    if (before.changes.length) {
      await page.getByRole("button", { name: "Got It" }).waitFor();
      assert.equal((await (await context.request.get(base)).json()).lastSeenVersion, before.lastSeenVersion);
      await page.route("**/app/changes/seen", route => route.fulfill({ status: 503, json: { error: "Temporary acknowledgement failure" } }), { times: 1 });
      await page.getByRole("button", { name: "Got It" }).click();
      await page.getByText("Temporary acknowledgement failure", { exact: true }).waitFor();
      assert.equal((await (await context.request.get(base)).json()).lastSeenVersion, before.lastSeenVersion);
      await page.getByRole("button", { name: "Got It" }).click();
      await page.getByRole("button", { name: "Got It" }).waitFor({ state: "hidden" });
      assert.equal((await (await context.request.get(base)).json()).changes.length, 0);
    }
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page.screenshot({ path: "/tmp/pobox-map-debug.png", fullPage: true });
    if (!missing) {
      await page.waitForFunction(() => window.mapAnnotations?.length > 0);
      const first = await page.evaluate(() => window.mapAnnotations[0].coordinate);
      assert.ok(first.latitude < 0 && first.longitude > 100);
      await page.evaluate(() => window.mapkit.dispatchEvent(new Event("configuration-error")));
      await page.locator(".map-fallback").waitFor();
      assert.equal(await page.getByText(/Check the map token/).count(), admin ? 1 : 0);
    } else {
      await page.locator(".map-fallback").waitFor();
      assert.equal(await page.getByText(/VITE_MAPKIT_TOKEN/).count(), admin ? 1 : 0);
    }
    assert.ok(await page.locator(".map-fallback a[href^='https://maps.apple.com']").count() > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/pobox-maps-${admin ? "admin" : "member"}-${missing ? "missing" : "error"}.png`, fullPage: true });
    await context.close();
  }
  console.log(`PASS: ${missing ? "missing-token" : "configured MapKit adapter and configuration-error"} fallback, admin-only diagnostics, map coordinates, release read/dismiss/failure retry, responsive layout.`);
} finally { await browser.close(); }
