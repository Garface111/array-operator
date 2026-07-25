// Form-factor regression guard.
//
// 2026-07-24: an UNFOLDED Galaxy Z Fold 5 (inner screen ~690x829 CSS px) was
// getting the phone shell. Routing to the /m React app used max-width 600px
// while the desktop SPA's mobile shell used max-width 960px, so the unfolded
// inner screen fell in the gap: too wide for /m, narrow enough for the touch
// shell -- the desktop site wearing its phone skin.
//
// Every surface now shares ONE predicate:
//
//     PHONE = (max-width: 600px)
//          or (max-height: 500px) and (max-width: 900px)
//
// i.e. the SHORT side is phone-sized. This pins (a) that every surface still
// agrees, and (b) that real devices land where Ford wants them:
//   folded foldable / phones -> the /m React app
//   unfolded foldable, tablets, desktop -> the full desktop site
//
// Run: node verify/form-factor.mjs
import fs from "node:fs";

const R = (p) => fs.readFileSync(p, "utf8");
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── the one true predicate ────────────────────────────────────────────────
const isPhone = (w, h) => w <= 600 || (h <= 500 && w <= 900);

// ── 1. every surface declares the same thing ──────────────────────────────
const CSS_PRED = "(max-width: 600px), (max-height: 500px) and (max-width: 900px)";
const surfaces = [
  ["public/mobile.css", CSS_PRED],
  ["public/mobile-os.css", CSS_PRED],
  ["public/theme-sky-mobile.css", "(max-width: 600px), (max-height: 500px) and (max-width: 900px)"],
  ["public/mobile-os.js", CSS_PRED],
  ["public/index.html", "w <= 600 || (h <= 500 && w <= 900)"],
  ["public/m/index.html", "w <= 600 || (h <= 500 && w <= 900)"],
  ["apps/owner-web/index.html", "w <= 600 || (h <= 500 && w <= 900)"],
];
for (const [file, needle] of surfaces) {
  check(`${file} carries the shared predicate`, R(file).includes(needle));
}

// nothing may still gate the phone shell at the old 960px line
for (const f of ["public/mobile.css", "public/mobile-os.css",
                 "public/theme-sky-mobile.css", "public/mobile-os.js"]) {
  const hits = [...R(f).matchAll(/@media[^{]*\b96[01]px|max-width:\s*96[01]px/g)];
  check(`${f} has no 960px shell gate`, hits.length === 0,
        hits.length ? hits[0][0].slice(0, 60) : "");
}

// ── 2. real devices land in the right place ───────────────────────────────
// CSS px, portrait and landscape. Fold 5: cover 344x882, inner ~690x829.
const DEVICES = [
  ["iPhone 15 portrait",            390,  844, true],
  ["iPhone 15 landscape",           844,  390, true],
  ["iPhone 15 Pro Max portrait",    430,  932, true],
  ["Pixel 7 portrait",              412,  892, true],
  ["Z Fold 5 FOLDED portrait",      344,  882, true],
  ["Z Fold 5 FOLDED landscape",     882,  344, true],
  ["Z Fold 5 UNFOLDED portrait",    690,  829, false],
  ["Z Fold 5 UNFOLDED landscape",   829,  690, false],
  ["iPad mini portrait",            744, 1133, false],
  ["iPad Pro portrait",            1024, 1366, false],
  ["iPad Pro landscape",           1366, 1024, false],
  ["laptop 1440x900",              1440,  900, false],
  ["desktop 1920x1080",            1920, 1080, false],
];
for (const [name, w, h, wantPhone] of DEVICES) {
  const got = isPhone(w, h);
  check(`${name} (${w}x${h}) -> ${wantPhone ? "phone app" : "desktop site"}`,
        got === wantPhone, got === wantPhone ? "" : `got ${got ? "phone" : "desktop"}`);
}

// ── 3. anything that MEASURES must sit below the viewport meta ────────────
// The 2026-07-24 reload loop: /m's form-factor guard ran above the viewport
// meta, so a phone reported its default ~980px layout viewport, read as a
// tablet, and handed back to "/" -- which measured 390px and handed straight
// back. Order is load-bearing and nothing else here would catch it.
for (const [file, marker] of [
  ["public/m/index.html", "FORM FACTOR"],
  ["apps/owner-web/index.html", "FORM FACTOR"],
  ["public/index.html", "function aoIsPhone()"],
]) {
  const html = R(file);
  const meta = html.search(/<meta[^>]*name=["']viewport["']/i);
  const measure = html.indexOf(marker);
  check(`${file}: viewport meta precedes the measuring script`,
        meta >= 0 && measure > meta,
        meta < 0 ? "no viewport meta" : `meta@${meta} measure@${measure}`);
}

// ── 4. a loop breaker exists, so no measurement bug can brick the app ─────
for (const f of ["public/m/index.html", "apps/owner-web/index.html"]) {
  check(`${f} caps redirect hand-offs`, R(f).includes("ao_ff_hops"));
}

// ── 5. the two redirects are mutually exclusive (no ping-pong) ────────────
// index.html sends phones to /m; /m hands non-phones back. If both could be
// true for one viewport the browser would bounce forever.
let overlap = 0;
for (let w = 200; w <= 2000; w += 1) {
  for (const h of [340, 400, 500, 600, 700, 830, 900, 1200]) {
    const toM = isPhone(w, h);      // index.html -> /m
    const toDesktop = !isPhone(w, h); // /m -> "/"
    if (toM && toDesktop) overlap++;
  }
}
check("index.html and /m can never both redirect", overlap === 0, `${overlap} overlaps`);

console.log(`\n${fails ? "FAILED" : "all checks passed"} — ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
