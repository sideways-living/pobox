import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
if (!process.env.REVIEW_SESSION || !process.env.MEMBER_SESSION) throw new Error("Start the isolated reviewBrowserServer fixture first.");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  async function client(cookie, email) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: "pobox_watch_session", value: cookie, url: "http://127.0.0.1:4189" }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      window.testSockets = [];
      window.WebSocket = class extends Native { constructor(...args) { super(...args); window.testSockets.push(this); } };
    });
    // Login is isolated fixture setup; all workspace requests and sockets are real.
    await page.route("**/auth/login", route => route.fulfill({ json: { ok: true } }));
    await page.goto("http://127.0.0.1:4189");
    await page.getByRole("button", { name: "Use Password to Set Up Security" }).click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("fixture");
    await page.getByRole("button", { name: "Continue with Password" }).click();
    const gotIt = page.getByRole("button", { name: "Got It" });
    await gotIt.waitFor(); await gotIt.click();
    await page.getByRole("button", { name: "Post Offices", exact: true }).click();
    return { context, page };
  }
  const admin = await client(process.env.REVIEW_SESSION, "daniel@example.com");
  const member = await client(process.env.MEMBER_SESSION, "john@example.com");
  const base = "http://127.0.0.1:4189/api/v1/workspaces/ws_company";
  const office = admin.page.getByRole("article", { name: "Melbourne GPO", exact: true });
  await office.getByTitle("Edit post office", { exact: true }).click();
  await office.getByLabel("Phone", { exact: true }).fill("My unsaved edit");
  const snapshot = await (await admin.context.request.get(`${base}/dashboard`)).json();
  const current = snapshot.postOffices.find(item => item.id === "po_melbourne_gpo");
  assert.equal((await admin.context.request.patch(`${base}/post-offices/${current.id}`, { data: { expectedUpdatedAt: current.updatedAt, phone: "Other user's edit" } })).status(), 200);
  await office.getByRole("button", { name: "Save", exact: true }).click();
  await admin.page.getByText("This post office changed. Cancel editing and reload before saving.", { exact: true }).waitFor();
  assert.equal(await office.getByLabel("Phone", { exact: true }).inputValue(), "My unsaved edit");
  await member.page.getByText("john@example.com", { exact: true }).waitFor();
  assert.equal(await member.page.getByTitle("Edit post office", { exact: true }).count(), 0);
  // Drop a socket while offline, mutate on the other client, then verify catch-up.
  await member.context.setOffline(true);
  await member.page.evaluate(() => window.testSockets.forEach(socket => socket.close()));
  const added = await admin.context.request.post(`${base}/post-offices`, { data: { name: "Reconnect Office", address: "1 Test St", latitude: -37, longitude: 145, geofenceRadius: 100 } });
  assert.equal(added.status(), 200);
  await member.context.setOffline(false);
  await member.page.getByRole("article", { name: "Reconnect Office", exact: true }).waitFor();
  await member.page.getByText("john@example.com", { exact: true }).waitFor();
  await member.page.screenshot({ path: "/tmp/pobox-multiuser-member.png", fullPage: true });
  assert.equal((await admin.context.request.delete(`${base}/team/users/usr_john`)).status(), 204);
  await member.page.getByRole("button", { name: "Continue with Passkey" }).waitFor();
  console.log("PASS: stale form rejected without losing draft, peer identity and role retained, offline reconnect catches missed changes, removed member returns to sign-in.");
} finally { await browser.close(); }
