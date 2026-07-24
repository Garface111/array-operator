// Mobile routing regression guard.
//
// On 2026-07-23 the phone -> /m route was switched off wholesale on the
// grounds that /m was broken, and /m itself was made to bounce browsers back
// to the desktop SPA. The app in fact boots and renders fine, so phone owners
// sat on a desktop layout. These checks pin the intended behavior so that
// cannot silently happen again.
//
// Run:  node verify/mobile-routing.mjs      (serve public/ with /m/* SPA
//       fallback on 127.0.0.1:8801, or set AO_BASE to a live origin)

import { chromium } from "playwright";

const BASE = process.env.AO_BASE || "http://127.0.0.1:8801";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function fastFont(ctx) { await ctx.route("**://fonts.googleapis.com/**", r => r.abort()); await ctx.route("**://fonts.gstatic.com/**", r => r.abort()); }

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 1024, height: 768 };

async function go(viewport, init, url = "/") {
  const ctx = await browser.newContext({ viewport });
  await fastFont(ctx);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  await page.goto(BASE + url, { waitUntil: "commit" }).catch(() => {});
  await page.waitForTimeout(900);
  const out = { url: page.url(), page, ctx };
  return out;
}

// 1) THE TRAP: a returning phone that already carries the machine-set
//    ao_force_desktop=1 from the 07-23 code must STILL reach /m.
{
  const { url, ctx } = await go(PHONE, () => {
    localStorage.setItem("so_session", "t");
    localStorage.setItem("ao_force_desktop", "1"); // planted by the old code
  });
  check("returning phone w/ stale ao_force_desktop reaches /m", /\/m\//.test(url), url);
  await ctx.close();
}

// 2) Clean signed-in phone -> /m
{
  const { url, ctx } = await go(PHONE, () => localStorage.setItem("so_session", "t"));
  check("signed-in phone -> /m", /\/m\//.test(url), url);
  await ctx.close();
}

// 3) Prospect on a phone (no session) stays on marketing
{
  const { url, ctx } = await go(PHONE, null);
  check("phone, no session stays on desktop/marketing", !/\/m\//.test(url), url);
  await ctx.close();
}

// 4) Tablet keeps the desktop SPA
{
  const { url, ctx } = await go(TABLET, () => localStorage.setItem("so_session", "t"));
  check("tablet + session stays on desktop SPA", !/\/m\//.test(url), url);
  await ctx.close();
}

// 5) /?desktop=1 opts out and PERSISTS across a later plain visit
{
  const ctx = await browser.newContext({ viewport: PHONE });
  await fastFont(ctx);
  await ctx.addInitScript(() => localStorage.setItem("so_session", "t"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?desktop=1`, { waitUntil: "commit" }).catch(() => {});
  await page.waitForTimeout(800);
  check("/?desktop=1 stays on desktop", !/\/m\//.test(page.url()), page.url());
  await page.goto(`${BASE}/`, { waitUntil: "commit" }).catch(() => {});
  await page.waitForTimeout(800);
  check("desktop preference persists on next visit", !/\/m\//.test(page.url()), page.url());
  await ctx.close();
}

// 6) /m no longer bounces a plain browser back to desktop, and it renders
{
  const ctx = await browser.newContext({ viewport: PHONE });
  await fastFont(ctx);
  await ctx.addInitScript(() => localStorage.setItem("so_session", "t"));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  await page.goto(`${BASE}/m/`, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(2500);
  const kids = await page.evaluate(() => document.getElementById("root")?.childElementCount ?? -1);
  check("/m in a plain browser does NOT bounce to desktop", /\/m\//.test(page.url()), page.url());
  check("/m renders the app", kids > 0, `#root children=${kids}`);
  check("/m no JS page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

// 7) No redirect loop: land on /m, confirm we settle (not ping-ponging)
{
  const ctx = await browser.newContext({ viewport: PHONE });
  await fastFont(ctx);
  await ctx.addInitScript(() => localStorage.setItem("so_session", "t"));
  const page = await ctx.newPage();
  let navs = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs++; });
  await page.goto(`${BASE}/`, { waitUntil: "commit" }).catch(() => {});
  await page.waitForTimeout(3000);
  check("no redirect loop (settles in few navigations)", navs <= 4, `navigations=${navs} final=${page.url()}`);
  await ctx.close();
}

// 8) Boot-failure fallback: if the SPA paints nothing, we land on desktop.
//    Simulate by blocking the app bundle so #root stays empty.
{
  const ctx = await browser.newContext({ viewport: PHONE });
  await fastFont(ctx);
  await ctx.addInitScript(() => localStorage.setItem("so_session", "t"));
  const page = await ctx.newPage();
  await page.route("**/m/assets/*.js", (r) => r.abort());
  await page.goto(`${BASE}/m/`, { waitUntil: "commit" }).catch(() => {});
  await page.waitForTimeout(4000); // asset-error bails immediately
  check("boot-failure falls back to desktop (no white screen)", !/\/m\//.test(page.url()), page.url());
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
