/**
 * Array Operator — surface atlas capture
 *
 * Walks every major owner-facing state on arrayoperator.com (demo session),
 * screenshots viewport + full page where useful, and dumps a DOM inventory
 * (ids, headings, primary CTAs) so we can build a micro/meso/macro mental model.
 *
 * Run from /tmp/ao-surface (has playwright): 
 *   node /root/array-operator/docs/surface-atlas/capture.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "shots");
const MANIFEST = path.join(__dirname, "manifest.json");
const BASE = process.env.AO_BASE || "https://arrayoperator.com";

fs.mkdirSync(OUT, { recursive: true });

async function demoToken() {
  const r = await fetch(`${BASE}/v1/demo/enter`);
  const j = await r.json();
  if (!j.session_token) throw new Error("no demo session: " + JSON.stringify(j).slice(0, 200));
  return j.session_token;
}

async function inventory(page) {
  return page.evaluate(() => {
    const active = document.querySelector(".panel.active") || document.body;
    const ids = Array.from(active.querySelectorAll("[id]"))
      .map((el) => el.id)
      .filter(Boolean)
      .slice(0, 80);
    const headings = Array.from(active.querySelectorAll("h1,h2,h3,[role='heading']"))
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 30);
    const buttons = Array.from(
      active.querySelectorAll("button, a.tab, a.ao-btn, .ao-btn, [role='tab'], [role='button']")
    )
      .map((el) => (el.textContent || el.getAttribute("aria-label") || el.title || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 80)
      .slice(0, 40);
    const segs = Array.from(document.querySelectorAll(".vs-seg-btn, .rb-subtab, [data-ansub], [data-gentab]"))
      .map((el) => ({
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
        on: el.classList.contains("on") || el.getAttribute("aria-pressed") === "true",
        id: el.id || null,
        data: el.getAttribute("data-ansub") || el.getAttribute("data-gentab") || null,
      }));
    const tabs = Array.from(document.querySelectorAll("#tabbar a.tab[href^='#']")).map((a) => ({
      id: a.id,
      href: a.getAttribute("href"),
      label: (a.textContent || "").replace(/\s+/g, " ").trim(),
      active: a.classList.contains("on") || a.getAttribute("aria-selected") === "true",
    }));
    return {
      hash: location.hash || "",
      title: document.title,
      activePanel: active.id || null,
      tabs,
      segs,
      headings,
      buttons: [...new Set(buttons)],
      ids,
      bodyTextSample: (active.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1200),
    };
  });
}

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.waitForTimeout(opts.wait || 800);
  // settle network a bit
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch (_) {}
  await page.waitForTimeout(opts.extra || 400);
  await page.screenshot({ path: file, fullPage: !!opts.fullPage });
  const inv = await inventory(page);
  return { name, file: path.relative(__dirname, file), ...inv, note: opts.note || "" };
}

async function safeClick(page, sel, timeout = 3000) {
  const el = page.locator(sel).first();
  if ((await el.count()) === 0) return false;
  try {
    await el.click({ timeout });
    return true;
  } catch (_) {
    return false;
  }
}

async function gotoHash(page, hash) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.waitForTimeout(900);
  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch (_) {}
  await page.waitForTimeout(600);
}

async function main() {
  const token = await demoToken();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // Inject session before first paint of app
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate((tok) => {
    localStorage.setItem("so_session", tok);
  }, token);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const entries = [];
  const nav = []; // edges: from → to via action

  // ── Signed-in shell states ─────────────────────────────────────────────
  const states = [
    {
      id: "01-inverters-sandbox",
      hash: "#arrays",
      note: "DEFAULT landing. Inverters tab · Sandbox sub-view (spatial fleet).",
      prep: async () => {
        await gotoHash(page, "#arrays");
        await safeClick(page, "#vsSegSandbox");
      },
    },
    {
      id: "02-inverters-spreadsheet",
      hash: "#arrays",
      note: "Inverters · Spreadsheet sub-view (rows by vendor).",
      prep: async () => {
        await gotoHash(page, "#arrays");
        await safeClick(page, "#vsSegSheet");
        await page.waitForTimeout(1000);
      },
    },
    {
      id: "03-fleet-triage",
      hash: "#dashboard",
      note: "Fleet Triage — KPI tiles + needs-attention queue.",
      prep: async () => gotoHash(page, "#dashboard"),
    },
    {
      id: "04-analysis-fleet",
      hash: "#analysis",
      note: "Analysis · Fleet analysis sub-view (NOC sections).",
      prep: async () => {
        await gotoHash(page, "#analysis");
        await safeClick(page, '#panelAnalysis [data-ansub="analysis"]');
        await page.waitForTimeout(1500);
      },
    },
    {
      id: "05-analysis-trends",
      hash: "#trends",
      note: "Analysis · Trends sub-view (NOT a top tab).",
      prep: async () => {
        await gotoHash(page, "#trends");
        await page.waitForTimeout(1500);
      },
    },
    {
      id: "06-invoices-offtakers",
      hash: "#reports",
      note: "Invoices · Offtakers list + pipeline + master rate.",
      prep: async () => {
        await gotoHash(page, "#reports");
        await safeClick(page, '#rbGenTabs [data-gentab="offtakers"]');
        await page.waitForTimeout(2000);
      },
    },
    {
      id: "07-invoices-bill-audit",
      hash: "#reports",
      note: "Invoices · Bill audit sub-view.",
      prep: async () => {
        await gotoHash(page, "#reports");
        await safeClick(page, '#rbGenTabs [data-gentab="audit"]');
        await page.waitForTimeout(1500);
      },
    },
    {
      id: "08-resources",
      hash: "#resources",
      note: "Resources — state briefing, news, REC market.",
      prep: async () => {
        await gotoHash(page, "#resources");
        await page.waitForTimeout(2000);
      },
    },
    {
      id: "09-account",
      hash: "#account",
      note: "Account — auto-refresh, profile, plan, AO bill, files.",
      prep: async () => {
        await gotoHash(page, "#account");
        await page.waitForTimeout(2000);
      },
    },
  ];

  let prev = null;
  for (const st of states) {
    await st.prep();
    const e = await shot(page, st.id, { fullPage: true, note: st.note, wait: 500, extra: 500 });
    entries.push(e);
    if (prev) {
      nav.push({ from: prev, to: st.id, via: `hash ${st.hash} (+ sub-view click if any)`, hash: st.hash });
    }
    prev = st.id;
    console.log("ok", st.id, e.headings.slice(0, 3).join(" | "));
  }

  // ── Overlays / secondary states from Inverters ─────────────────────────
  await gotoHash(page, "#arrays");
  await safeClick(page, "#vsSegSandbox");
  await page.waitForTimeout(800);

  // Add array modal
  if (await safeClick(page, "#sbAddArray")) {
    await page.waitForTimeout(700);
    const e = await shot(page, "10-modal-add-array", {
      note: "Modal: + Add array (one-click vendor login path).",
      fullPage: false,
    });
    entries.push(e);
    nav.push({ from: "01-inverters-sandbox", to: "10-modal-add-array", via: "click #sbAddArray" });
    // close
    await safeClick(page, "#sbCancel");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    console.log("ok 10-modal-add-array");
  }

  // Alerts from Fleet Triage if present
  await gotoHash(page, "#dashboard");
  if (await safeClick(page, "#fcAlerts")) {
    await page.waitForTimeout(700);
    const e = await shot(page, "11-panel-fleet-alerts", {
      note: "Fleet alerts settings panel (email when inverter needs attention).",
      fullPage: false,
    });
    entries.push(e);
    nav.push({ from: "03-fleet-triage", to: "11-panel-fleet-alerts", via: "click #fcAlerts" });
    await safeClick(page, "#aoAlX");
    await page.keyboard.press("Escape");
    console.log("ok 11-panel-fleet-alerts");
  }

  // Energy Agent orb open
  if (await safeClick(page, "#eaOrb, .ea-orb, #eaFab, button[aria-label*='Energy'], #eaOpen")) {
    await page.waitForTimeout(900);
    const e = await shot(page, "12-energy-agent-open", {
      note: "Energy Agent panel open (voice/chat orb).",
      fullPage: false,
    });
    entries.push(e);
    nav.push({ from: "any", to: "12-energy-agent-open", via: "open Energy Agent orb (global)" });
    console.log("ok 12-energy-agent-open");
  } else {
    // try common orb selectors
    const orb = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll("button, a, div[role='button']"));
      const hit = cands.find((el) => /energy agent|talk to|ask/i.test(el.textContent || el.getAttribute("aria-label") || ""));
      if (hit) {
        hit.click();
        return true;
      }
      // last resort: #ea root
      const root = document.getElementById("eaRoot") || document.querySelector(".ea-shell, .ea-panel");
      return !!root;
    });
    if (orb) {
      await page.waitForTimeout(800);
      const e = await shot(page, "12-energy-agent-open", {
        note: "Energy Agent surface (opened if found).",
        fullPage: false,
      });
      entries.push(e);
      console.log("ok 12-energy-agent-open (alt)");
    } else {
      console.log("skip energy agent open — selector not found");
    }
  }

  // Hands-off setup pill if present
  if (await safeClick(page, "#hoPill, .ho-pill, [id*='hoPill']")) {
    await page.waitForTimeout(800);
    const e = await shot(page, "13-hands-off-setup", {
      note: "Hands-off setup walkthrough panel.",
      fullPage: false,
    });
    entries.push(e);
    nav.push({ from: "any", to: "13-hands-off-setup", via: "click hands-off FAB" });
    console.log("ok 13-hands-off-setup");
  }

  // Login / signed-out marketing (fresh context)
  const page2 = await context.newPage();
  await page2.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page2.waitForTimeout(800);
  await page2.screenshot({ path: path.join(OUT, "00-login.png"), fullPage: true });
  const invLogin = await page2.evaluate(() => ({
    hash: location.hash,
    title: document.title,
    headings: Array.from(document.querySelectorAll("h1,h2")).map((h) => h.textContent.trim()),
    bodyTextSample: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 800),
  }));
  entries.unshift({
    name: "00-login",
    file: "shots/00-login.png",
    note: "Sign-in page (pre-session).",
    ...invLogin,
    tabs: [],
    segs: [],
    buttons: [],
    ids: [],
    activePanel: null,
  });
  nav.push({ from: "00-login", to: "01-inverters-sandbox", via: "magic link / password / demo session → / #arrays" });

  // Anon marketing home (no session)
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page3 = await ctx3.newPage();
  await page3.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page3.waitForTimeout(2000);
  await page3.screenshot({ path: path.join(OUT, "00b-anon-home.png"), fullPage: true });
  entries.splice(1, 0, {
    name: "00b-anon-home",
    file: "shots/00b-anon-home.png",
    note: "Anonymous home — demo fleet / marketing (no so_session).",
    hash: "",
    title: await page3.title(),
    headings: await page3.$$eval("h1,h2", (els) => els.map((e) => e.textContent.trim()).slice(0, 12)),
    bodyTextSample: await page3.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 800)),
    tabs: [],
    segs: [],
    buttons: [],
    ids: [],
    activePanel: null,
  });
  nav.push({ from: "00b-anon-home", to: "00-login", via: "Sign in" });
  nav.push({ from: "00b-anon-home", to: "01-inverters-sandbox", via: "demo enter / onboarding complete" });
  await ctx3.close();

  const graph = {
    captured_at: new Date().toISOString(),
    base: BASE,
    session: "demo (/v1/demo/enter)",
    viewport: "1440x900",
    states: entries,
    navigation: nav,
    // Canonical product nav (always true regardless of capture order)
    product_nav: {
      top_tabs: [
        { label: "Fleet Triage", hash: "#dashboard", panel: "#panelDashboard" },
        { label: "Inverters", hash: "#arrays", panel: "#panelArrays", default: true },
        { label: "Analysis", hash: "#analysis", panel: "#panelAnalysis" },
        { label: "Invoices", hash: "#reports", panel: "#panelReports" },
        { label: "Resources", hash: "#resources", panel: "#panelResources" },
        { label: "Account", hash: "#account", panel: "#panelAccount" },
      ],
      sub_views: {
        Inverters: [
          { label: "Sandbox", control: "#vsSegSandbox" },
          { label: "Spreadsheet", control: "#vsSegSheet" },
        ],
        Analysis: [
          { label: "Fleet analysis", control: '[data-ansub="analysis"]', hash: "#analysis" },
          { label: "Trends", control: '[data-ansub="trends"]', hash: "#trends" },
        ],
        Invoices: [
          { label: "Offtakers", control: '[data-gentab="offtakers"]' },
          { label: "Bill audit", control: '[data-gentab="audit"]' },
        ],
      },
      global: [
        { label: "Energy Agent orb", note: "Always available when signed in" },
        { label: "Hands-off setup FAB", note: "Bottom-left when setup incomplete" },
        { label: "Fleet alerts", note: "From Fleet Triage Monitoring tile or Inverters" },
      ],
    },
  };

  fs.writeFileSync(MANIFEST, JSON.stringify(graph, null, 2));
  console.log("\nWrote", MANIFEST, "states=", entries.length);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
