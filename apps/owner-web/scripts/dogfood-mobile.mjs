/**
 * Systematic click-through of the mobile React app in demo mode.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.AO_MOBILE_URL || "https://arrayoperator.com/m";
const OUT = path.resolve("dogfood-output");
fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });

const issues = [];
const consoleErrors = [];
const pageErrors = [];
const log = (m) => console.log(m);
function issue(sev, title, detail) {
  issues.push({ sev, title, detail });
  console.log(`  [${sev}] ${title}: ${detail}`);
}
async function shot(page, name) {
  const p = path.join(OUT, "screenshots", `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}
async function safe(label, fn) {
  try { await fn(); }
  catch (e) { issue("High", label, (e.message || String(e)).slice(0, 400)); }
}
async function closeAgent(page) {
  const x = page.locator('section[role="dialog"] button[aria-label="Close"]');
  if (await x.count()) await x.first().click({ force: true, timeout: 2000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  const api401 = [];
  page.on("pageerror", (e) => { pageErrors.push(String(e)); console.log("  PAGEERROR", e.message); });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      if (/favicon|fonts\.gstatic|Clarity|clarity/i.test(t)) return;
      consoleErrors.push(t);
    }
  });
  page.on("response", (r) => {
    if (r.status() === 401 && r.url().includes("/v1/")) api401.push(r.url());
  });

  log("1. Demo fleet");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${BASE}/fleet?demo=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  await shot(page, "02-fleet");
  const sticky = await page.evaluate(() => localStorage.getItem("ao_owner_demo"));
  if (sticky !== "1") issue("High", "Demo not sticky", `ao_owner_demo=${sticky}`);
  const body = await page.locator("body").innerText();
  if (!/Fleet|Green Mountain|kW/i.test(body)) issue("High", "Fleet blank", body.slice(0, 200));

  log("2. Fleet expand + agent investigate");
  await safe("Expand all", async () => {
    const ea = page.getByRole("button", { name: /Expand all/i });
    if (await ea.count()) { await ea.click(); await page.waitForTimeout(400); }
  });
  await safe("Flagged + investigate", async () => {
    const flagged = page.getByRole("button", { name: /Flagged/i });
    if (await flagged.count()) {
      await flagged.first().click();
      await page.waitForTimeout(800);
      await shot(page, "04-flagged");
    }
    const dock = page.getByLabel("Open Energy Agent");
    if (!(await page.locator('section[role="dialog"]').count()) && await dock.count()) {
      await dock.click();
      await page.waitForTimeout(600);
    }
    const input = page.getByPlaceholder(/Ask|Listening|type|message/i);
    if (await input.count()) {
      await input.fill("Investigate the underperforming inverter on Cover Rooftop.");
      await page.getByRole("button", { name: /^Send$/ }).click();
      await page.waitForTimeout(2500);
      await shot(page, "06-investigate");
      const reply = await page.locator('section[role="dialog"]').innerText();
      if (!/Cover|SE10K|peer|investigat/i.test(reply))
        issue("Medium", "Agent investigate reply thin", reply.slice(0, 200));
      log("  investigate: " + reply.slice(0, 180).replace(/\n/g, " | "));
    }
    await closeAgent(page);
  });

  log("3. Tabs");
  for (const tab of ["Invoices", "Resources", "Account", "Fleet"]) {
    await safe(`Tab ${tab}`, async () => {
      await page.getByRole("link", { name: tab, exact: true }).click();
      await page.waitForTimeout(600);
      await shot(page, `07-tab-${tab.toLowerCase()}`);
    });
  }

  log("4. Add offtaker");
  await safe("Add offtaker", async () => {
    await page.getByRole("link", { name: "Invoices", exact: true }).click();
    await page.waitForTimeout(500);
    const add = page.getByRole("button", { name: /^Add$/ });
    if (!(await add.count())) throw new Error("Add missing");
    await add.click();
    await page.waitForTimeout(300);
    await page.getByPlaceholder(/Customer name/i).fill("Dogfood Test Offtaker");
    const email = page.getByPlaceholder(/Email/i);
    if (await email.count()) await email.fill("dogfood@example.com");
    const share = page.locator('input').filter({ has: page.locator('xpath=.') });
    // allocation field
    const pct = page.locator('input[name="allocation_pct"], input[placeholder="10"]');
    if (await pct.count()) await pct.first().fill("12.5");
    await shot(page, "08-offtaker-form");
    await page.getByRole("button", { name: /Create offtaker/i }).click();
    await page.waitForTimeout(1000);
    await shot(page, "09-offtaker-submit");
    const after = await page.locator("body").innerText();
    if (!/Dogfood Test Offtaker|Added/i.test(after))
      issue("High", "Create offtaker did not add to roster", after.slice(0, 250));
    log("  after create: " + after.slice(0, 200).replace(/\n/g, " | "));
  });

  await safe("Preview PDF", async () => {
    const preview = page.getByRole("button", { name: /Preview PDF/i });
    if (!(await preview.count())) throw new Error("Preview missing");
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 5000 }).catch(() => null),
      preview.first().click(),
    ]);
    await page.waitForTimeout(600);
    await shot(page, "10-preview");
    if (popup) {
      const t = await popup.locator("body").innerText().catch(() => "");
      log("  preview popup: " + t.slice(0, 120).replace(/\n/g, " | "));
      if (!/Demo|invoice|preview/i.test(t))
        issue("Medium", "Preview content unexpected", t.slice(0, 150));
      await popup.close().catch(() => {});
    } else {
      issue("Medium", "Preview PDF no popup", "window.open may be blocked");
    }
  });

  await safe("Edit offtaker", async () => {
    const edit = page.getByRole("button", { name: /^Edit$/ });
    if (!(await edit.count())) throw new Error("Edit missing");
    await edit.first().click();
    await page.waitForTimeout(400);
    await shot(page, "11-edit");
    const close = page.getByRole("button", { name: /^Close$/ });
    if (await close.count()) await close.first().click();
  });

  log("5. Resources + Account + Connect");
  await safe("Resources", async () => {
    await page.getByRole("link", { name: "Resources", exact: true }).click();
    await page.waitForTimeout(700);
    const chips = page.locator("button").filter({ hasText: /Hampshire|Mass|Vermont|Maine/i });
    if (await chips.count()) await chips.first().click();
    await shot(page, "12-resources");
  });

  await safe("Connect SolarEdge", async () => {
    await page.getByRole("link", { name: "Account", exact: true }).click();
    await page.waitForTimeout(500);
    const connect = page.getByRole("link", { name: /Open connect|Connect/i });
    if (!(await connect.count())) throw new Error("Connect link missing");
    await connect.first().click();
    await page.waitForTimeout(700);
    await shot(page, "14-connect");
    const se = page.getByPlaceholder(/SolarEdge API key/i);
    if (!(await se.count())) throw new Error("SE input missing");
    await se.fill("fake-key-dogfood");
    await page.getByRole("button", { name: /Connect SolarEdge/i }).click();
    await page.waitForTimeout(1000);
    await shot(page, "15-solaredge");
    const t = await page.locator("body").innerText();
    if (!/Sign in|demo|failed|error/i.test(t))
      issue("Medium", "SolarEdge demo submit no feedback", t.slice(0, 150));
    log("  se: " + t.slice(0, 180).replace(/\n/g, " | "));
  });

  log("6. Agent confirm card");
  await safe("Agent confirm", async () => {
    await page.getByRole("link", { name: "Fleet", exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByLabel("Open Energy Agent").click();
    await page.waitForTimeout(600);
    const input = page.getByPlaceholder(/Ask|Listening|type|message/i);
    await input.fill("Update Town Library allocation please");
    await page.getByRole("button", { name: /^Send$/ }).click();
    await page.waitForTimeout(2000);
    await shot(page, "22-confirm");
    const confirm = page.getByRole("button", { name: /Confirm|Apply|Yes/i });
    if (await confirm.count()) {
      await confirm.first().click();
      await page.waitForTimeout(800);
      await shot(page, "23-confirmed");
    } else {
      issue("Medium", "No confirm card for update prompt", "");
    }
    await closeAgent(page);
  });

  // 401 check after sticky demo
  const unique401 = [...new Set(api401)];
  if (unique401.length) {
    issue("High", "API 401s while in demo", unique401.slice(0, 8).join("\n"));
  }

  await browser.close();
  const report = [
    "# Mobile dogfood report",
    "",
    `URL: ${BASE}`,
    `Time: ${new Date().toISOString()}`,
    "",
    `## Issues (${issues.length})`,
    ...issues.map((i, n) => `### ${n + 1}. [${i.sev}] ${i.title}\n${i.detail}\n`),
    "",
    `## Page errors (${pageErrors.length})`,
    ...pageErrors.map((e) => `- ${e}`),
    "",
    `## Console errors (${consoleErrors.length})`,
    ...consoleErrors.slice(0, 30).map((e) => `- ${e}`),
    "",
    `## API 401 count: ${api401.length}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "report.md"), report);
  console.log("\n=== SUMMARY ===\n" + report);
  if (issues.some((i) => i.sev === "Critical" || i.sev === "High") || pageErrors.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
