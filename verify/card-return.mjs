/**
 * card-return.mjs — closed-loop verification for the Stripe add-card RETURN path
 * (the trial→paid conversion flow's landing leg).
 *
 * Drives the LIVE deployed dashboard in a headless browser and asserts what the
 * 2026-07-02 conversion lane shipped:
 *   1. CARD ADDED    — /?card_added=1 renders the #trialNudge success state
 *                      ("Card saved…"), scrubs the params from the URL, and never
 *                      leaves the returning operator staring at a silent dashboard.
 *   2. CARD CANCELLED— /?card_cancelled=1 renders the neutral "no card was added,
 *                      nothing was charged" state (second-chance CTA when signed in).
 *   3. NO REPLAY     — after landing, a reload does NOT re-show the confirmation
 *                      (params were history.replaceState-scrubbed).
 *   4. (optional, SO_SMOKE_SESSION env) STRIPE BOUNDARY — with a real trial session,
 *      the Master Account "Add credit card" flow returns a live
 *      https://checkout.stripe.com URL. We stop AT the boundary — no navigation
 *      into Stripe, no card entry, ever.
 *
 * Credential-free by default (tests the signed-out shapes of the same code paths).
 * Exit 0 = all hold. Usage: node card-return.mjs   |   AO_URL=… node card-return.mjs
 */
import { chromium } from "playwright";

const BASE = (process.env.AO_URL || "https://arrayoperator.com").replace(/\/$/, "");
const HEADED = !!process.env.HEADED;
const SMOKE_SESSION = process.env.SO_SMOKE_SESSION || "";

const results = [];
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const pass = (n) => { results.push(["PASS", n]); console.log("  ✓", n); };
const fail = (n, d) => { results.push(["FAIL", n, d]); console.log("  ✗", n, "\n       →", d); };
const check = (name, cond, detail) => (cond ? pass(name) : fail(name, detail || "assertion failed"));

async function barState(page) {
  return page.evaluate(() => {
    const bar = document.getElementById("trialNudge");
    const copy = document.getElementById("trialNudgeCopy");
    const cta = document.getElementById("trialNudgeCta");
    return {
      exists: !!bar,
      hidden: bar ? bar.hidden : null,
      cls: bar ? bar.className : "",
      copy: copy ? copy.textContent : "",
      ctaText: cta ? cta.textContent : "",
      ctaShown: cta ? cta.style.display !== "none" : false,
      url: location.href,
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage();

  console.log("Test 1 — /?card_added=1 renders the success confirmation");
  await page.goto(BASE + "/?card_added=1", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  let s = await barState(page);
  check("confirmation bar is visible", s.exists && s.hidden === false, JSON.stringify(s));
  check("bar carries the success state", /\bsuccess\b/.test(s.cls), s.cls);
  check('copy confirms "Card saved"', /card saved/i.test(norm(s.copy)), s.copy);
  check("card_added param was scrubbed from the URL", !/card_added|session_id/.test(s.url), s.url);

  console.log("Test 2 — reload does not replay the confirmation");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  s = await barState(page);
  check("no stale 'Card saved' after reload", !( !s.hidden && /card saved/i.test(norm(s.copy)) ), JSON.stringify(s));

  console.log("Test 3 — /?card_cancelled=1 renders the honest neutral state");
  await page.goto(BASE + "/?card_cancelled=1", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  s = await barState(page);
  check("neutral bar is visible", s.exists && s.hidden === false, JSON.stringify(s));
  check("bar carries the neutral state", /\bneutral\b/.test(s.cls), s.cls);
  check("copy says nothing was charged", /no card was added and nothing was charged/i.test(norm(s.copy)), s.copy);
  check("card_cancelled param was scrubbed", !/card_cancelled/.test(s.url), s.url);

  if (SMOKE_SESSION) {
    console.log("Test 4 — signed-in add-card reaches the Stripe checkout BOUNDARY (and stops)");
    const p2 = await browser.newPage();
    await p2.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await p2.evaluate((tok) => localStorage.setItem("so_session", tok), SMOKE_SESSION);
    const res = await p2.evaluate(async (tok) => {
      const r = await fetch("/v1/account/add-payment-method", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: "{}",
      });
      const d = await r.json().catch(() => ({}));
      return { status: r.status, url: d && d.checkout_url };
    }, SMOKE_SESSION);
    check("add-payment-method returns 200", res.status === 200, "HTTP " + res.status);
    check("checkout_url is a live Stripe Checkout URL",
      typeof res.url === "string" && /^https:\/\/checkout\.stripe\.com\//.test(res.url),
      String(res.url));
    // BOUNDARY: we never navigate to it and never enter card details.
    await p2.close();
  } else {
    console.log("Test 4 — skipped (set SO_SMOKE_SESSION to exercise the Stripe boundary)");
  }

  await browser.close();
  const failed = results.filter(([r]) => r === "FAIL");
  console.log("─".repeat(58));
  if (failed.length) {
    console.log(`${results.length - failed.length}/${results.length} passed — ${failed.length} FAILED`);
    process.exit(1);
  }
  console.log(`${results.length}/${results.length} invariants hold — ALL GREEN`);
}

main().catch((e) => { console.error("harness crashed:", e); process.exit(2); });
