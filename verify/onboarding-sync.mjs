/**
 * onboarding-sync.mjs — closed-loop verification for the Array Operator onboarding
 * "find every array I own" sync.
 *
 * Drives the LIVE deployed onboarding in a real (headless) browser and REPLAYS the exact
 * window messages the EnergyAgent extension emits — SO_EXTENSION_PRESENT / SO_CAPTURE_LANDED /
 * SO_LOGIN_STATE — then asserts the invariants we earned debugging the Chint hang.
 *
 * Credential-free + deterministic: it does NOT load the extension or sign into any vendor — it
 * SIMULATES the extension's events through the page's own window.postMessage channel (matching
 * the same-origin guard at onboarding.html:319). So it verifies the page's LOGIC + UX-invariants
 * — the exact layer where every Chint bug actually lived — NOT real capture. The real-capture
 * and taste layers can't be closed headless and are documented in README.md (a live
 * Claude-in-Chrome pass + a vision judge on the screenshot this harness drops).
 *
 * Each invariant below = a bug we fixed, now frozen as a guard:
 *   1. HAPPY PATH       — all four vendors land → tiles "found", tally "8 arrays", no spinner left.
 *   2. CHINT SEQUENCING — Chint's portal opens ONLY after the fast vendors settle, never at the
 *                         old concurrent ~900ms (that concurrency caused the false-login_required hang).
 *   3. NO ETERNAL SPIN  — a Chint that never captures resolves to a clickable "Sign in to add",
 *                         never a frozen "signing in…".
 *   4. CAPTURE WINS     — a (false) login_required during sign-in never blocks a capture that
 *                         follows; the tile still ends "found".
 *
 * Exit 0 = all hold. Non-zero = a regression. Safe to gate a deploy on.
 *   Usage:  node onboarding-sync.mjs            (headless, live prod)
 *           HEADED=1 node onboarding-sync.mjs   (watch it)
 *           ONB_URL=http://localhost:8080/onboarding node onboarding-sync.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.ONB_URL || "https://arrayoperator.com/onboarding";
const HEADED = !!process.env.HEADED;

const results = [];
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const pass = (n) => { results.push(["PASS", n]); console.log("  ✓", n); };
const fail = (n, d) => { results.push(["FAIL", n, d]); console.log("  ✗", n, "\n       →", d); };
const check = (name, cond, detail) => (cond ? pass(name) : fail(name, detail || "assertion failed"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bootstrap a fresh onboarding page: install a message recorder + injectors, then announce the
// extension exactly as the bridge does (flips EXT_PRESENT + auto-starts the sync).
async function startSyncPage(browser) {
  const page = await browser.newPage();
  await page.goto(URL + (URL.includes("?") ? "&" : "?") + "verify=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => typeof window.startSyncAll === "function" && typeof window.go === "function", { timeout: 15000 });
  await page.evaluate(() => {
    window.__log = [];
    window.__t0 = Date.now();
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const d = e.data; if (!d || typeof d !== "object" || !d.type) return;
      window.__log.push({ ms: Date.now() - window.__t0, type: d.type, provider: d.provider, state: d.state, n: d.sites && d.sites.length });
    }, true);
    window.__inject = (provider, n) => {
      const sites = Array.from({ length: n }, (_, i) => ({ site_id: provider + "-" + (i + 1), name: provider + " site " + (i + 1), peak_power_kw: 100 + i, inverters: [] }));
      window.postMessage({ type: "SO_CAPTURE_LANDED", ok: true, provider, sites }, location.origin);
    };
    window.__loginState = (provider, state) => window.postMessage({ type: "SO_LOGIN_STATE", provider, state }, location.origin);
    if (typeof go === "function") go(1);                                 // Connect screen
    window.postMessage({ type: "SO_EXTENSION_PRESENT" }, location.origin); // → EXT_PRESENT + startSyncAll
  });
  // The "Your arrays" screen + its live status tiles must come up.
  await page.waitForFunction(() => {
    const b = document.getElementById("syncStatus");
    return b && /checking|signing|array|none|Sign in/i.test(b.textContent || "");
  }, { timeout: 8000 });
  return page;
}

const inject = (page, v, n) => page.evaluate(([v, n]) => window.__inject(v, n), [v, n]);
const loginState = (page, v, s) => page.evaluate(([v, s]) => window.__loginState(v, s), [v, s]);
const syncBar = (page) => page.evaluate(() => (document.getElementById("syncStatus") || {}).textContent || "");
const tally = (page) => page.evaluate(() => (document.getElementById("tally") || {}).textContent || "");
const chintOpened = (page) => page.evaluate(() => window.__log.some((e) => e.type === "SO_OPEN_PORTAL" && e.provider === "chint"));
const waitChintOpen = (page) => page.waitForFunction(() => window.__log.some((e) => e.type === "SO_OPEN_PORTAL" && e.provider === "chint"), { timeout: 15000 }).catch(() => {});

async function landFastVendors(page) {
  await inject(page, "solaredge", 3);
  await inject(page, "fronius", 2);
  await inject(page, "sma", 2);
}

async function run() {
  console.log("Onboarding sync verification →", URL, "\n");
  const browser = await chromium.launch({ headless: !HEADED });
  try {
    // ── Test 1+2: happy path + Chint sequencing ───────────────────────────────────────────
    console.log("Test 1 — happy path + Chint sequencing");
    try {
      const page = await startSyncPage(browser);
      // For >1.3s after start (past the OLD concurrent 900ms fire) and BEFORE any fast vendor
      // settles, Chint must NOT have opened. This is the direct guard on the concurrency bug.
      await sleep(1300);
      check("Chint does not open concurrently (silent until fast vendors settle)", !(await chintOpened(page)),
        "Chint opened in the first 1.3s — the concurrent-900ms regression is back");
      await landFastVendors(page);
      await waitChintOpen(page);
      check("Chint opens solo after the fast vendors settle", await chintOpened(page), "Chint never opened after the fast vendors settled");
      const seq = await page.evaluate(() => {
        const L = window.__log;
        const c = L.find((e) => e.type === "SO_OPEN_PORTAL" && e.provider === "chint");
        const lastFast = [...L].reverse().find((e) => e.type === "SO_CAPTURE_LANDED" && ["solaredge", "fronius", "sma"].includes(e.provider));
        return { c: c && c.ms, f: lastFast && lastFast.ms };
      });
      check("Chint opens strictly AFTER the last fast capture", seq.c != null && seq.f != null && seq.c >= seq.f, `chint@${seq.c}ms vs lastFast@${seq.f}ms`);
      await inject(page, "chint", 1);
      await page.waitForFunction(() => { const b = document.getElementById("syncStatus"); return b && !/checking|signing in/i.test(b.textContent || ""); }, { timeout: 6000 }).catch(() => {});
      const bar = await syncBar(page), tal = await tally(page);
      check('All four vendors show "found" (no spinner left)', !/checking|signing in/i.test(bar), `syncStatus="${norm(bar)}"`);
      check("Tally reads 8 arrays", /\b8 arrays\b/.test(tal), `tally="${norm(tal)}"`);
      mkdirSync("artifacts", { recursive: true });
      await page.screenshot({ path: "artifacts/onboarding-happy.png", fullPage: true });
      console.log("       (screenshot → verify/artifacts/onboarding-happy.png)");
      await page.close();
    } catch (e) { fail("Test 1 happy path + sequencing", String(e && e.message || e)); }

    // ── Test 3: no eternal spinner ────────────────────────────────────────────────────────
    console.log('Test 3 — a non-capturing Chint resolves to "Sign in to add", never eternal spin');
    try {
      const page = await startSyncPage(browser);
      await sleep(1300);
      await landFastVendors(page);
      await waitChintOpen(page);
      // Chint opened but no capture arrives → trigger the sync's honest stop.
      await page.evaluate(() => { if (typeof finishSyncAll === "function") finishSyncAll(); });
      await sleep(400);
      const bar = await syncBar(page);
      check('No tile left on "signing in…" after settle', !/signing in/i.test(bar), `syncStatus="${norm(bar)}"`);
      check('Chint resolves to a clickable "Sign in to add"', /Sign in to add/i.test(bar), `syncStatus="${norm(bar)}"`);
      await page.close();
    } catch (e) { fail("Test 3 no eternal spinner", String(e && e.message || e)); }

    // ── Test 4: capture wins over a false login_required ───────────────────────────────────
    console.log("Test 4 — a false login_required during sign-in never blocks a capture");
    try {
      const page = await startSyncPage(browser);
      await sleep(1300);
      await landFastVendors(page);
      await waitChintOpen(page);
      await loginState(page, "chint", "login_required");  // the false signal seen ~200ms after open
      await sleep(200);
      await inject(page, "chint", 1);                      // the real capture follows
      await sleep(400);
      const bar = await syncBar(page);
      check('Chint ends "found", not stuck on the false login_required', /1 array/.test(bar) && !/signing in/i.test(bar), `syncStatus="${norm(bar)}"`);
      await page.close();
    } catch (e) { fail("Test 4 capture wins", String(e && e.message || e)); }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log("\n" + "─".repeat(58));
  console.log(`${results.length - failed}/${results.length} invariants hold` + (failed ? ` — ${failed} FAILED` : " — ALL GREEN"));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error("harness crashed:", e); process.exit(2); });
