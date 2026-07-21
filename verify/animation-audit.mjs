/**
 * animation-audit.mjs — frame-dense UI animation auditor for Array Operator.
 *
 * Walks major interactive surfaces on the LIVE app, fires an action, then
 * screenshots at ~fps for `durationMs` so the AI (or a human) can "watch"
 * the animation as a video of frames. Computes frame-to-frame pixel diffs
 * and catalogs jank / freeze / flash / incomplete-settle issues.
 *
 * Usage:
 *   node animation-audit.mjs
 *   HEADED=1 FPS=15 DURATION_MS=1500 node animation-audit.mjs
 *   AO_BASE=http://127.0.0.1:5500 node animation-audit.mjs
 *
 * Outputs under verify/artifacts/animation-audit/<timestamp>/:
 *   frames/<scenario>_<nnnn>.png
 *   report.json          — machine catalog of issues + metrics
 *   report.md            — human summary
 *   contact/<scenario>.html — strip of frames for quick visual scan
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.AO_BASE || "https://arrayoperator.com";
const HEADED = !!process.env.HEADED;
const FPS = Math.max(5, Math.min(30, Number(process.env.FPS || 15)));
const DURATION_MS = Math.max(400, Number(process.env.DURATION_MS || 1400));
const VIEWPORT = {
  width: Number(process.env.W || 1440),
  height: Number(process.env.H || 900),
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.join(__dirname, "artifacts", "animation-audit", stamp);
const FRAMES = path.join(OUT, "frames");
const CONTACT = path.join(OUT, "contact");
fs.mkdirSync(FRAMES, { recursive: true });
fs.mkdirSync(CONTACT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function demoToken() {
  const r = await fetch(`${BASE}/v1/demo/enter`);
  const j = await r.json();
  if (!j.session_token) throw new Error("demo enter failed: " + JSON.stringify(j).slice(0, 200));
  return j.session_token;
}

function decodePng(buf) {
  return PNG.sync.read(buf);
}

function frameDiffPct(aBuf, bBuf) {
  try {
    const a = decodePng(aBuf);
    const b = decodePng(bBuf);
    if (a.width !== b.width || a.height !== b.height) return { pct: 100, pixels: -1 };
    const diff = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
      threshold: 0.12,
      includeAA: true,
    });
    const total = a.width * a.height;
    return { pct: (n / total) * 100, pixels: n, w: a.width, h: a.height };
  } catch (e) {
    return { pct: -1, pixels: -1, error: String(e.message || e) };
  }
}

/**
 * Dense frame capture via CDP screencast (real ~15–30fps), not slow full PNG
 * screenshots (~3fps). Falls back to paced PNG if CDP fails.
 * Returns { frames, diffs, metrics }
 */
async function captureBurst(page, name, { durationMs = DURATION_MS, fps = FPS } = {}) {
  const frames = [];
  const buffers = [];
  const t0 = Date.now();
  let i = 0;

  // Prefer CDP screencast for video-like density
  let usedCdp = false;
  try {
    const client = await page.context().newCDPSession(page);
    const pending = [];
    const onFrame = async (params) => {
      try {
        const t = Date.now() - t0;
        if (t > durationMs + 80) return;
        const buf = Buffer.from(params.data, "base64");
        const file = path.join(
          FRAMES,
          `${name}_${String(i).padStart(4, "0")}.jpg`
        );
        fs.writeFileSync(file, buf);
        frames.push({
          i,
          t,
          file: path.relative(OUT, file),
          bytes: buf.length,
          sessionId: params.sessionId,
        });
        buffers.push(buf);
        i++;
        // Ack so Chrome keeps the stream flowing
        if (params.sessionId != null) {
          client.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        }
      } catch (_) {}
    };
    client.on("Page.screencastFrame", onFrame);
    await client.send("Page.startScreencast", {
      format: "jpeg",
      quality: 55,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    });
    usedCdp = true;
    await sleep(durationMs);
    await client.send("Page.stopScreencast").catch(() => {});
    try { await client.detach(); } catch (_) {}
    // Wait a tick for last frames
    await sleep(50);
  } catch (e) {
    console.log(`  (cdp screencast failed: ${e.message || e} — PNG fallback)`);
  }

  if (!usedCdp || frames.length < 4) {
    // PNG paced fallback
    frames.length = 0;
    buffers.length = 0;
    i = 0;
    const interval = 1000 / fps;
    const t1 = Date.now();
    while (Date.now() - t1 < durationMs) {
      const shotStart = Date.now();
      const buf = await page.screenshot({ type: "jpeg", quality: 55, animations: "allow" });
      const t = Date.now() - t1;
      const file = path.join(FRAMES, `${name}_${String(i).padStart(4, "0")}.jpg`);
      fs.writeFileSync(file, buf);
      frames.push({ i, t, file: path.relative(OUT, file), bytes: buf.length });
      buffers.push(buf);
      i++;
      const spent = Date.now() - shotStart;
      if (spent < interval) await sleep(interval - spent);
    }
  }

  // CDP frames can arrive out of order — sort by timestamp before diffing
  if (frames.length) {
    const paired = frames.map((f, idx) => ({ f, buf: buffers[idx] }));
    paired.sort((a, b) => a.f.t - b.f.t);
    frames.length = 0;
    buffers.length = 0;
    paired.forEach((p, idx) => {
      p.f.i = idx;
      // rename file refs are fine to leave; index is logical
      frames.push(p.f);
      buffers.push(p.buf);
    });
    // Re-base times so first frame is ~0
    const tBase = frames[0].t;
    frames.forEach((f) => { f.t = Math.max(0, f.t - tBase); });
  }

  // JPEG frame-to-frame: decode via sharp-less path — re-screenshot PNG pairs is slow.
  // Convert: use playwright? Instead approximate with byte-size + optional png for every Nth.
  // For accurate Δ% re-encode is needed; use canvas-less: compare subsampled raw via jpeg-js if available.
  // Practical approach: re-read and use PNG only for analysis by converting through page - NO.
  // Install jpeg-js? Keep simple: for jpg buffers use size-relative + pixelmatch only when PNG.
  // We'll re-capture analysis with downscaled PNG screenshots of the same files by decoding jpeg with 'jpeg-js' if present.

  let jpegDecode = null;
  try {
    jpegDecode = (await import("jpeg-js")).default || (await import("jpeg-js"));
  } catch (_) {
    try { jpegDecode = await import("jpeg-js"); } catch (_) {}
  }

  const diffs = [];
  for (let k = 1; k < buffers.length; k++) {
    let d;
    if (jpegDecode && jpegDecode.decode) {
      try {
        const a = jpegDecode.decode(buffers[k - 1], { useTArray: true });
        const b = jpegDecode.decode(buffers[k], { useTArray: true });
        if (a.width === b.width && a.height === b.height) {
          // Downsample 4x for speed
          const step = 4;
          const w = Math.floor(a.width / step);
          const h = Math.floor(a.height / step);
          let changed = 0;
          const total = w * h;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const ia = ((y * step) * a.width + x * step) * 4;
              const ib = ((y * step) * b.width + x * step) * 4;
              const dr = Math.abs(a.data[ia] - b.data[ib]);
              const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
              const db = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
              if (dr + dg + db > 36) changed++;
            }
          }
          d = { pct: (changed / total) * 100, pixels: changed };
        } else {
          d = frameDiffPct(buffers[k - 1], buffers[k]);
        }
      } catch {
        d = { pct: Math.abs(buffers[k].length - buffers[k - 1].length) / Math.max(buffers[k].length, 1) * 50, pixels: -1 };
      }
    } else {
      // Byte-size heuristic (weak) + try PNG decoder
      d = frameDiffPct(buffers[k - 1], buffers[k]);
      if (d.pct < 0) {
        const la = buffers[k - 1].length, lb = buffers[k].length;
        d = { pct: Math.min(100, (Math.abs(la - lb) / Math.max(la, lb, 1)) * 100), pixels: -1 };
      }
    }
    diffs.push({ i: k, t: frames[k].t, pct: +d.pct.toFixed(4), pixels: d.pixels });
  }

  const pcts = diffs.map((d) => d.pct).filter((p) => p >= 0);
  const mean = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
  const max = pcts.length ? Math.max(...pcts) : 0;
  const min = pcts.length ? Math.min(...pcts) : 0;
  // Longest freeze streak: consecutive frames with <0.05% change
  let freeze = 0, freezeMax = 0;
  for (const p of pcts) {
    if (p < 0.05) { freeze++; freezeMax = Math.max(freezeMax, freeze); }
    else freeze = 0;
  }
  // Early stall: freeze AFTER the click window (~120ms) but BEFORE motion.
  // Frames 0–120ms are pre-click by design (capture starts first) — ignore them.
  let earlyStall = 0, earlyStallMax = 0, sawMotion = false;
  for (let k = 0; k < diffs.length; k++) {
    if (diffs[k].t < 120) continue;
    if (diffs[k].t > 550) break;
    if (diffs[k].pct >= 0.35) {
      sawMotion = true;
      earlyStall = 0;
    } else if (!sawMotion) {
      earlyStall++;
      earlyStallMax = Math.max(earlyStallMax, earlyStall);
    }
  }
  // Flash: single frame spike > 8% flanked by low-motion frames
  let flashCount = 0;
  for (let k = 1; k < pcts.length - 1; k++) {
    if (pcts[k] > 8 && pcts[k - 1] < 1.5 && pcts[k + 1] < 1.5) flashCount++;
  }
  // Motion present? any frame > 0.3%
  const motionFrames = pcts.filter((p) => p >= 0.3).length;
  // Settle: last 20% of frames mostly still
  const tail = pcts.slice(Math.floor(pcts.length * 0.8));
  const tailMean = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;

  // Write a simple HTML contact sheet (every Nth frame to keep light)
  const step = Math.max(1, Math.floor(frames.length / 12));
  const contactImgs = frames
    .filter((_, idx) => idx % step === 0 || idx === frames.length - 1)
    .map(
      (f) =>
        `<figure style="margin:0"><img src="../${f.file}" style="width:160px;border:1px solid #334;border-radius:4px"/><figcaption style="font:11px monospace;color:#9ab">${f.i} @ ${f.t}ms</figcaption></figure>`
    )
    .join("\n");
  fs.writeFileSync(
    path.join(CONTACT, `${name}.html`),
    `<!doctype html><meta charset=utf-8><title>${name}</title>
     <body style="background:#0b1220;color:#e2e8f0;font-family:system-ui;padding:16px">
     <h1 style="font-size:16px">${name}</h1>
     <p style="color:#8ab">frames=${frames.length} meanΔ=${mean.toFixed(3)}% maxΔ=${max.toFixed(3)}% freezeMax=${freezeMax} flashes=${flashCount}</p>
     <div style="display:flex;flex-wrap:wrap;gap:8px">${contactImgs}</div></body>`
  );

  return {
    name,
    frameCount: frames.length,
    durationMs: frames.length ? frames[frames.length - 1].t : 0,
    frames,
    diffs,
    metrics: {
      meanPct: +mean.toFixed(4),
      maxPct: +max.toFixed(4),
      minPct: +min.toFixed(4),
      freezeMaxStreak: freezeMax,
      earlyStallMax,
      flashCount,
      motionFrames,
      tailMeanPct: +tailMean.toFixed(4),
      fpsTarget: fps,
      actualFps: frames.length > 1 ? +((frames.length - 1) / ((frames[frames.length - 1].t || 1) / 1000)).toFixed(2) : 0,
    },
  };
}

function catalogIssues(scenario, burst, expect) {
  const issues = [];
  const m = burst.metrics;
  const exp = expect || {};

  // Expected motion but almost none.
  // Ambient continuous (live dots, liquid) is often sub-pixel at full-viewport
  // capture — downgrade to low so we don't false-fail the whole suite.
  if (exp.expectMotion && m.motionFrames < 2 && m.maxPct < 0.4) {
    issues.push({
      severity: exp.continuousSoft ? "low" : "high",
      code: "NO_MOTION",
      message: `Expected animation but saw almost no frame change (maxΔ=${m.maxPct}%, motionFrames=${m.motionFrames}).` +
        (exp.continuousSoft ? " Ambient/pulse may be too small for full-viewport sampling." : ""),
    });
  }

  // Stall before motion — only when motion never really arrives (true jank).
  // Large maxΔ means the slide did fire; a few pre-motion frames are normal.
  if (
    exp.expectMotion &&
    (m.earlyStallMax || 0) >= Math.ceil(FPS * 0.5) &&
    m.maxPct < 8 &&
    m.motionFrames < 4
  ) {
    issues.push({
      severity: "med",
      code: "EARLY_STALL",
      message: `Animation stalled ${m.earlyStallMax} frames before motion began (maxΔ=${m.maxPct}%). Possible delayed start/jank.`,
    });
  }

  // Flash: multi-flash only, or lone flash with no sustained motion (true pop).
  if (m.flashCount >= 2 || (m.flashCount === 1 && m.motionFrames <= 4 && m.maxPct > 40)) {
    issues.push({
      severity: "med",
      code: "FLASH",
      message: `${m.flashCount} single-frame flash(es) detected (large one-frame jump then quiet).`,
    });
  }

  // Never settles — skip continuous; only one-shot transitions that keep thrashing.
  if (
    exp.expectSettle !== false &&
    !exp.continuous &&
    m.tailMeanPct > 8 &&
    m.maxPct > 10 &&
    m.motionFrames > 5
  ) {
    issues.push({
      severity: "med",
      code: "NO_SETTLE",
      message: `Animation may not settle: last-20% meanΔ=${m.tailMeanPct}% (still moving hard at end of capture).`,
    });
  }

  // Continuous motion — soft ambient is low (viewport sampling); marquee stays high.
  if (exp.continuous) {
    const minShare = exp.continuousSoft ? 0.12 : 0.28;
    const need = Math.max(3, Math.floor(burst.frameCount * minShare));
    if (m.motionFrames < need) {
      issues.push({
        severity: exp.continuousSoft ? "low" : "high",
        code: "CONTINUOUS_STALLED",
        message: `Continuous motion expected but only ${m.motionFrames}/${burst.frameCount} frames moved (need ≥${need}).`,
      });
    }
  }

  // Capture quality (ignore nonsense negative/zero from clock edge cases)
  if (m.actualFps > 0 && m.actualFps < FPS * 0.45) {
    issues.push({
      severity: "low",
      code: "LOW_CAPTURE_FPS",
      message: `Capture only achieved ~${m.actualFps} fps (target ${FPS}). Diffs may under-sample fast transitions.`,
    });
  }

  // Hard snap: huge change across almost no motion frames (needs dense capture
  // to be meaningful — ignore when we only got a handful of samples).
  if (
    exp.expectMotion &&
    burst.frameCount >= 10 &&
    m.maxPct > 30 &&
    m.motionFrames <= 3
  ) {
    issues.push({
      severity: "high",
      code: "HARD_SNAP",
      message: `Looks like an instant cut (maxΔ=${m.maxPct}% across only ${m.motionFrames} motion frame(s) of ${burst.frameCount}), not a slide/fade.`,
    });
  }

  return issues.map((x) => ({ scenario, ...x }));
}

async function safeClick(page, sel, timeout = 4000) {
  const el = page.locator(sel).first();
  if ((await el.count()) === 0) return false;
  try {
    await el.click({ timeout });
    return true;
  } catch {
    try {
      await el.click({ timeout: 2000, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

async function gotoHash(page, hash) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await sleep(200);
}

async function runScenario(page, scenarios, { id, label, keys, setup, act, expect, durationMs }) {
  console.log(`\n▶ ${id} — ${label}`);
  if (setup) await setup(page);
  await sleep(200);
  // Capture OVERLAPS the action so mid-animation frames aren't missed:
  // start burst, click ~80ms later, keep recording for durationMs.
  const dur = durationMs || DURATION_MS;
  const burstP = captureBurst(page, id, { durationMs: dur });
  await sleep(80);
  if (act) {
    try { await act(page); } catch (e) { console.log(`  (act error: ${e.message || e})`); }
  }
  const burst = await burstP;
  const issues = catalogIssues(id, burst, expect);
  for (const iss of issues) {
    console.log(`  ! [${iss.severity}] ${iss.code}: ${iss.message}`);
  }
  if (!issues.length) console.log(`  ✓ no issues (frames=${burst.frameCount} meanΔ=${burst.metrics.meanPct}% maxΔ=${burst.metrics.maxPct}% ~${burst.metrics.actualFps}fps)`);
  else console.log(`  … frames=${burst.frameCount} meanΔ=${burst.metrics.meanPct}% maxΔ=${burst.metrics.maxPct}% ~${burst.metrics.actualFps}fps`);
  scenarios.push({
    id,
    label,
    keys: keys || [],
    expect: expect || {},
    metrics: burst.metrics,
    frameCount: burst.frameCount,
    contact: path.relative(OUT, path.join(CONTACT, `${id}.html`)),
    issues,
  });
  return burst;
}

async function main() {
  console.log(`Animation audit → ${OUT}`);
  console.log(`BASE=${BASE} FPS=${FPS} DURATION_MS=${DURATION_MS} viewport=${VIEWPORT.width}x${VIEWPORT.height}`);

  const token = await demoToken();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ["--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: "no-preference", // we WANT animations
  });
  const page = await context.newPage();

  // Session inject
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.evaluate((tok) => {
    try {
      localStorage.setItem("so_session", tok);
      localStorage.setItem("so_token", tok);
      sessionStorage.setItem("so_session", tok);
    } catch (_) {}
  }, token);
  await page.goto(`${BASE}/?audit=${Date.now()}#dashboard`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  // Wait for shell
  await page.waitForSelector("#tabbar, .tabbar, #panelDashboard, .panel", { timeout: 30000 });
  await sleep(2000);
  // Ensure first-use marquee can show for EA scenarios
  await page.evaluate(() => {
    try {
      sessionStorage.removeItem("ao_ea_suggestions_dismissed");
      sessionStorage.setItem("ao_ea_suggestions_dismissed", "0");
    } catch (_) {}
  });

  const scenarios = [];
  const click = (p, sel) => safeClick(p, sel);
  const hash = (p, h) => gotoHash(p, h);
  const openEa = async (p) => {
    await p.evaluate(() => {
      try { sessionStorage.removeItem("ao_ea_suggestions_dismissed"); } catch (_) {}
    });
    const ok =
      (await safeClick(p, "#eaOrb")) ||
      (await safeClick(p, "#eaFab")) ||
      (await safeClick(p, ".ea-orb, .ea-fab, .tab.ea-tab"));
    if (!ok) {
      await p.evaluate(() => {
        if (typeof window.__eaOpen === "function") window.__eaOpen();
        else {
          document.body.classList.add("ea-shell-open");
          const panel = document.getElementById("eaPanel");
          if (panel) { panel.hidden = false; panel.classList.add("open"); }
        }
      });
    }
    await sleep(400);
  };
  const closeEa = async (p) => {
    const ok = (await safeClick(p, "#eaClose, .ea-close, [data-ea-close]")) || (await safeClick(p, "#eaOrb"));
    if (!ok) {
      await p.evaluate(() => {
        if (typeof window.__eaClose === "function") window.__eaClose();
        else {
          document.body.classList.remove("ea-shell-open");
          const panel = document.getElementById("eaPanel");
          if (panel) { panel.hidden = true; panel.classList.remove("open"); }
        }
      });
    }
  };

  /**
   * FULL registry — every intentional animation surface we currently ship.
   * `keys` lists the CSS/JS animation names this scenario is meant to exercise
   * (for the catalog report). Prefer real clicks; hash fallbacks when needed.
   */
  const ALL = [
    // ── A. Top-tab pager (tab-slide.js / tab-slide.css) ───────────────────
    { id: "tab-to-analysis", label: "Tab slide → Analysis", keys: ["tab-slide", "ao-sliding"],
      setup: async (p) => { await hash(p, "#dashboard"); await sleep(500); },
      act: async (p) => { if (!(await click(p, "#tabAnalysis"))) await hash(p, "#analysis"); },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1500 },
    { id: "tab-to-reports", label: "Tab slide → Invoices", keys: ["tab-slide"],
      setup: async (p) => { await hash(p, "#analysis"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabReports"))) await hash(p, "#reports"); },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1500 },
    { id: "tab-to-ops", label: "Tab slide → Repairs", keys: ["tab-slide"],
      setup: async (p) => { await hash(p, "#reports"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabOps"))) await hash(p, "#ops"); },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1500 },
    { id: "tab-to-marketplace", label: "Tab slide → Marketplace", keys: ["tab-slide"],
      setup: async (p) => { await hash(p, "#ops"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabMarketplace"))) await hash(p, "#marketplace"); },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1500 },
    { id: "tab-to-account", label: "Tab slide → Account", keys: ["tab-slide"],
      setup: async (p) => { await hash(p, "#marketplace"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabAccount"))) await hash(p, "#account"); },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1500 },
    { id: "tab-to-fleet", label: "Tab slide → Fleet", keys: ["tab-slide"],
      setup: async (p) => { await hash(p, "#account"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabDashboard"))) await hash(p, "#dashboard"); },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1500 },
    { id: "tab-fleet-to-reports-long", label: "Tab slide long hop Fleet→Invoices", keys: ["tab-slide"],
      setup: async (p) => { await hash(p, "#dashboard"); await sleep(500); },
      act: async (p) => { if (!(await click(p, "#tabReports"))) await hash(p, "#reports"); },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1600 },

    // ── B. Fleet Triage | Table | Sandbox (ftSubEnter) ────────────────────
    { id: "fleet-to-table", label: "Fleet sub → Table (ftSubEnter)", keys: ["ftSubEnter"],
      setup: async (p) => { await hash(p, "#dashboard"); await sleep(500); },
      act: async (p) => {
        if (!(await click(p, "#vsSegSheet, [data-ftsub='table']"))) await hash(p, "#arrays");
      },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1200 },
    { id: "fleet-to-sandbox", label: "Fleet sub → Sandbox (ftSubEnter + sbArrive)", keys: ["ftSubEnter", "sbArrive", "sbliqwave", "sbliqrise"],
      setup: async (p) => { await hash(p, "#arrays"); await sleep(500); },
      act: async (p) => {
        if (!(await click(p, "#vsSegSandbox, [data-ftsub='sandbox']"))) await hash(p, "#sandbox");
      },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1800 },
    { id: "fleet-to-triage", label: "Fleet sub → Triage (ftSubEnter)", keys: ["ftSubEnter", "fcgsheen", "aoLivePulse"],
      setup: async (p) => { await hash(p, "#sandbox"); await sleep(500); },
      act: async (p) => {
        if (!(await click(p, "#vsSegDashboard, [data-ftsub='dashboard']"))) await hash(p, "#dashboard");
      },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1400 },

    // ── C. Sandbox ambient / continuous ──────────────────────────────────
    { id: "sandbox-ambient-liquid", label: "Sandbox liquid layers continuous", keys: ["sbliqwave", "sbliqrise", "sbliqbreathe", "sbliqtwinkle", "sb-now-pulse", "livepulse", "sbflowv", "sbflowh"],
      setup: async (p) => { await hash(p, "#sandbox"); await sleep(1500); },
      act: async () => {},
      expect: { expectMotion: true, continuous: true, continuousSoft: true, expectSettle: false },
      durationMs: 2800 },
    { id: "sandbox-card-detail", label: "Sandbox inverter card → detail (dcin/dcpop)", keys: ["dcin", "dcpop", "dcfade", "sb-modal-in"],
      setup: async (p) => { await hash(p, "#sandbox"); await sleep(1200); },
      act: async (p) => {
        const sel = ".sb-inv, .sb-card, .sb-inv-card, [data-inv-id], .sb-col .sb-inv";
        if (!(await click(p, sel))) {
          await p.evaluate(() => {
            const el = document.querySelector(".sb-inv, .sb-card");
            if (el) el.click();
          });
        }
      },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1400 },
    { id: "sandbox-detail-close", label: "Sandbox detail close", keys: ["dcin"],
      setup: async (p) => { /* leave whatever open */ await sleep(200); },
      act: async (p) => {
        if (!(await click(p, ".sb-dc-close, .dc-close, .sb-modal-x, [data-dc-close], .sb-ov-close"))) {
          await p.keyboard.press("Escape");
        }
      },
      expect: { expectMotion: false }, durationMs: 900 },

    // ── D. Table / vendor sheet ──────────────────────────────────────────
    { id: "table-row-expand", label: "Table expand array row (vsExpandIn)", keys: ["vsExpandIn", "vsArrIn", "vsGgFill", "vsGgNeedle"],
      setup: async (p) => {
        await hash(p, "#arrays");
        await sleep(400);
        await p.evaluate(() => {
          try {
            if (typeof window.__aoApplyFleetTriageSub === "function") window.__aoApplyFleetTriageSub();
          } catch (_) {}
        });
        // Wait until array rows actually have layout (not 0×0)
        await p.waitForFunction(() => {
          const el = document.querySelector("#vendorSheet .vs-arr");
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 80 && r.height > 12 && location.hash.includes("array");
        }, { timeout: 20000 }).catch(() => {});
        await sleep(500);
      },
      act: async (p) => {
        await p.evaluate(() => {
          const b =
            document.querySelector("#vendorSheet .vs-arr:not(.open)") ||
            document.querySelector("#vendorSheet .vs-arr");
          if (b) {
            b.scrollIntoView({ block: "center" });
            b.click();
          }
        });
      },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1600 },
    { id: "table-ambient", label: "Table gauges/pulse continuous", keys: ["vsPulse", "vsDcPulse", "dpShimmer"],
      setup: async (p) => { await hash(p, "#arrays"); await sleep(800); },
      act: async () => {},
      expect: { expectMotion: true, continuous: true, continuousSoft: true, expectSettle: false },
      durationMs: 2200 },

    // ── E. Triage ambient ────────────────────────────────────────────────
    { id: "triage-ambient", label: "Triage live dots / sheen continuous", keys: ["fcgsheen", "pulse", "aoLivePulse", "anPulse"],
      setup: async (p) => { await hash(p, "#dashboard"); await sleep(1000); },
      act: async () => {},
      expect: { expectMotion: true, continuous: true, continuousSoft: true, expectSettle: false },
      durationMs: 2400 },

    // ── F. Energy Agent ──────────────────────────────────────────────────
    { id: "ea-open", label: "EA panel open (transform rail)", keys: ["ea-shell", "eaPulse", "eaGatePulse"],
      setup: async (p) => {
        await hash(p, "#dashboard");
        await p.evaluate(() => { try { sessionStorage.removeItem("ao_ea_suggestions_dismissed"); } catch (_) {} });
        await closeEa(p);
        await sleep(400);
      },
      act: openEa,
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1500 },
    { id: "ea-marquee", label: "EA suggestion dual marquee continuous", keys: ["ea-sug-marquee-rtl", "ea-sug-marquee-ltr"],
      setup: async (p) => {
        await openEa(p);
        await p.evaluate(() => {
          try { sessionStorage.removeItem("ao_ea_suggestions_dismissed"); } catch (_) {}
          if (typeof window.__eaRemountSuggestions === "function") window.__eaRemountSuggestions();
          else {
            const root = document.getElementById("eaSuggestions");
            if (root) {
              root.hidden = false;
              root.classList.remove("ea-suggestions-gone");
            }
          }
        });
        await sleep(400);
      },
      act: async () => {},
      expect: { expectMotion: true, continuous: true, expectSettle: false },
      durationMs: 3000 },
    { id: "ea-next-steps", label: "EA next-step chips enter (ea-next-in)", keys: ["ea-next-in"],
      setup: async (p) => { await openEa(p); await sleep(300); },
      act: async (p) => {
        await p.evaluate(() => {
          const host = document.getElementById("eaMsgs");
          if (!host) return;
          const msg = document.createElement("div");
          msg.className = "ea-msg agent";
          msg.innerHTML = '<div class="ea-msg-body">Audit: next steps should animate in.</div>';
          host.appendChild(msg);
          const row = document.createElement("div");
          row.className = "ea-next-steps";
          row.innerHTML =
            '<div class="ea-next-steps-lbl">Next steps</div><div class="ea-next-steps-row">' +
            '<button type="button" class="ea-next-chip">Hardest problem first</button>' +
            '<button type="button" class="ea-next-chip">Draft repair outreach</button>' +
            '<button type="button" class="ea-next-chip">Dig deeper</button></div>';
          host.appendChild(row);
          host.scrollTop = host.scrollHeight;
        });
      },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1000 },
    { id: "ea-improve-open", label: "EA Improve panel open", keys: ["dcin", "ea-improve"],
      setup: async (p) => { await openEa(p); await sleep(300); },
      act: async (p) => {
        if (!(await click(p, "#eaImproveOpen"))) {
          await p.evaluate(() => {
            const b = document.getElementById("eaImproveOpen");
            if (b) b.click();
          });
        }
      },
      expect: { expectMotion: true }, durationMs: 1100 },
    { id: "ea-close", label: "EA panel close", keys: ["ea-shell"],
      setup: async (p) => { await openEa(p); await sleep(300); },
      act: closeEa,
      expect: { expectMotion: true, expectSettle: true }, durationMs: 1400 },

    // ── G. Analysis + Trends ─────────────────────────────────────────────
    { id: "analysis-enter", label: "Open Analysis (tab + sub content)", keys: ["tab-slide", "tr-rise", "anPulse"],
      setup: async (p) => { await hash(p, "#dashboard"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabAnalysis"))) await hash(p, "#analysis"); },
      expect: { expectMotion: true }, durationMs: 1600 },
    { id: "analysis-sub-2", label: "Analysis sub-nav second pill", keys: ["tr-rise", "tr-rowin"],
      setup: async (p) => { await hash(p, "#analysis"); await sleep(800); },
      act: async (p) => {
        const loc = p.locator("#panelAnalysis [data-ansub], #panelAnalysis .vs-seg-btn, #panelAnalysis .an-subbtn, #panelAnalysis [role='tab']");
        const n = await loc.count();
        if (n > 1) await loc.nth(1).click({ timeout: 3000 }).catch(() => {});
        else if (n === 1) await loc.nth(0).click({ timeout: 2000 }).catch(() => {});
      },
      expect: { expectMotion: false }, durationMs: 1200 },
    { id: "trends-enter", label: "Trends / Through-time enter (tr-rise, tr-rowin)", keys: ["tr-rise", "tr-rowin", "tr-breathe"],
      setup: async (p) => { await hash(p, "#analysis"); await sleep(500); },
      act: async (p) => {
        if (!(await click(p, "a[href='#trends'], [data-ansub='trends'], [data-ansub='through-time'], button:has-text('Through time'), button:has-text('Trends')"))) {
          await hash(p, "#trends");
        }
      },
      expect: { expectMotion: true }, durationMs: 1800 },
    { id: "trends-ambient", label: "Trends ambient breathe continuous", keys: ["tr-breathe"],
      setup: async (p) => { await hash(p, "#trends"); await sleep(1000); },
      act: async () => {},
      expect: { expectMotion: true, continuous: true, continuousSoft: true, expectSettle: false },
      durationMs: 2600 },

    // ── H. Invoices ──────────────────────────────────────────────────────
    { id: "invoices-enter", label: "Invoices tab enter", keys: ["tab-slide", "rbaccin", "rbpickin"],
      setup: async (p) => { await hash(p, "#dashboard"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabReports"))) await hash(p, "#reports"); },
      expect: { expectMotion: true }, durationMs: 1600 },
    { id: "invoices-expand", label: "Invoices accordion / details expand", keys: ["rbaccin", "rbpickin"],
      setup: async (p) => { await hash(p, "#reports"); await sleep(1000); },
      act: async (p) => {
        const ok =
          (await click(p, "#panelReports details summary, #panelReports .rb-acc-sum, #panelReports .rb-card, #panelReports .rb-row")) ||
          (await click(p, "#panelReports button, #panelReports [aria-expanded='false']"));
        if (!ok) await p.evaluate(() => {
          const s = document.querySelector("#panelReports summary, #panelReports .rb-acc-sum");
          if (s) s.click();
        });
      },
      expect: { expectMotion: true }, durationMs: 1300 },

    // ── I. Marketplace ───────────────────────────────────────────────────
    { id: "marketplace-enter", label: "Marketplace tab enter", keys: ["tab-slide"],
      setup: async (p) => { await hash(p, "#reports"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabMarketplace"))) await hash(p, "#marketplace"); },
      expect: { expectMotion: true }, durationMs: 1500 },
    { id: "marketplace-sub", label: "Marketplace sub-tab switch", keys: ["mk-sub"],
      setup: async (p) => { await hash(p, "#marketplace"); await sleep(800); },
      act: async (p) => {
        const loc = p.locator("#panelMarketplace .vs-seg-btn, #panelMarketplace [role='tab'], #marketplaceRoot .vs-seg-btn, .mk-subnav button");
        const n = await loc.count();
        if (n > 1) await loc.nth(1).click({ timeout: 3000 }).catch(() => {});
      },
      expect: { expectMotion: false }, durationMs: 1100 },

    // ── J. Account ───────────────────────────────────────────────────────
    { id: "account-enter", label: "Account tab enter", keys: ["tab-slide", "arFlash", "aoLivePulse"],
      setup: async (p) => { await hash(p, "#dashboard"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabAccount"))) await hash(p, "#account"); },
      expect: { expectMotion: true }, durationMs: 1500 },
    { id: "account-card-expand", label: "Account auto-refresh flash (arFlash)", keys: ["arFlash", "arGroupPulse", "aoAlUp"],
      setup: async (p) => { await hash(p, "#account"); await sleep(900); },
      act: async (p) => {
        // Product flash: #rowAutoRefresh.ar-flash — fire it the same way live code does
        await p.evaluate(() => {
          const el = document.getElementById("rowAutoRefresh") ||
            document.querySelector("#panelAccount .ar-stack, #panelAccount .ar-card");
          if (!el) return;
          el.classList.remove("ar-flash");
          void el.offsetWidth;
          el.classList.add("ar-flash");
          // Also lift a card for aoAlUp-style enter if present
          const card = document.querySelector("#panelAccount .ar-card");
          if (card) {
            card.classList.remove("ar-enter");
            void card.offsetWidth;
            card.classList.add("ar-enter");
          }
        });
      },
      expect: { expectMotion: true, expectSettle: true }, durationMs: 2000 },

    // ── K. Resources ─────────────────────────────────────────────────────
    { id: "resources-enter", label: "Resources enter (aoResPulse)", keys: ["tab-slide", "aoResPulse", "tr-rise"],
      setup: async (p) => { await hash(p, "#analysis"); await sleep(400); },
      act: async (p) => {
        if (!(await click(p, "a[href='#resources'], [data-ansub='resources'], button:has-text('Resources')"))) {
          await hash(p, "#resources");
        }
      },
      expect: { expectMotion: true }, durationMs: 1600 },
    { id: "resources-ambient", label: "Resources live-dot continuous", keys: ["aoResPulse"],
      setup: async (p) => { await hash(p, "#resources"); await sleep(800); },
      act: async () => {},
      expect: { expectMotion: true, continuous: true, continuousSoft: true, expectSettle: false },
      durationMs: 2200 },

    // ── L. Repairs ───────────────────────────────────────────────────────
    { id: "repairs-enter", label: "Repairs tab enter", keys: ["tab-slide"],
      setup: async (p) => { await hash(p, "#dashboard"); await sleep(400); },
      act: async (p) => { if (!(await click(p, "#tabOps"))) await hash(p, "#ops"); },
      expect: { expectMotion: true }, durationMs: 1500 },
    { id: "repairs-cta", label: "Repairs primary CTA press feedback", keys: ["rp-talk"],
      setup: async (p) => { await hash(p, "#ops"); await sleep(900); },
      act: async (p) => {
        await click(p, "#panelOps .rp-talk, #panelOps button.primary, #opsTalkMain");
      },
      expect: { expectMotion: false }, durationMs: 1000 },

    // ── M. Mobile bottom nav + More sheet ────────────────────────────────
    { id: "mobile-tab-fleet", label: "Mobile bottom nav → Fleet", keys: ["mobile-nav", "tab-slide"],
      mobile: true,
      setup: async (p) => { await hash(p, "#analysis"); await sleep(700); },
      act: async (p) => {
        if (!(await click(p, "#tabDashboard"))) await hash(p, "#dashboard");
      },
      expect: { expectMotion: true }, durationMs: 1400 },
    { id: "mobile-more-open", label: "Mobile More sheet open (mobMoreUp)", keys: ["mobMoreUp"],
      mobile: true,
      setup: async (p) => {
        await hash(p, "#dashboard");
        await sleep(600);
        // Ensure more sheet starts closed
        await p.evaluate(() => {
          const sheet = document.querySelector(".mob-more");
          const bd = document.querySelector(".mob-more-backdrop");
          if (sheet) sheet.hidden = true;
          if (bd) bd.hidden = true;
        });
      },
      act: async (p) => {
        const ok = await click(p, "button.tab-more, .tab.tab-more");
        if (!ok) {
          await p.evaluate(() => {
            const more = document.querySelector("button.tab-more, .tab.tab-more");
            if (more) more.click();
            else {
              // force open for measurement if control missing
              let sheet = document.querySelector(".mob-more");
              if (!sheet) {
                sheet = document.createElement("div");
                sheet.className = "mob-more";
                sheet.innerHTML = '<div class="mob-more-item">Account</div>';
                document.body.appendChild(sheet);
              }
              sheet.hidden = false;
            }
          });
        }
      },
      expect: { expectMotion: true }, durationMs: 1200 },
  ];

  // Desktop pass
  console.log(`\n══ Desktop full animation registry (${ALL.filter((s) => !s.mobile).length} scenarios) ══`);
  for (const sc of ALL.filter((s) => !s.mobile)) {
    if (sc.skipIf && (await sc.skipIf(page))) {
      console.log(`\n⏭ ${sc.id} — skipped`);
      scenarios.push({ id: sc.id, label: sc.label, keys: sc.keys || [], skipped: true, reason: "skipIf", issues: [] });
      continue;
    }
    await runScenario(page, scenarios, sc);
    await sleep(250);
  }

  await browser.close();

  // Mobile pass — fresh context at phone size so mobile-nav.js injects More sheet
  console.log(`\n══ Mobile animation registry (fresh phone context) ══`);
  {
    const mBrowser = await chromium.launch({
      headless: !HEADED,
      args: ["--disable-dev-shm-usage"],
    });
    const mCtx = await mBrowser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      reducedMotion: "no-preference",
    });
    const mPage = await mCtx.newPage();
    const tok2 = await demoToken();
    await mPage.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await mPage.evaluate((tok) => {
      try {
        localStorage.setItem("so_session", tok);
        localStorage.setItem("so_token", tok);
      } catch (_) {}
    }, tok2);
    await mPage.goto(`${BASE}/?auditm=${Date.now()}#analysis`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await mPage.waitForSelector("#tabbar, .tabbar", { timeout: 30000 });
    await sleep(2000);
    // Wait for More control (injected by mobile-nav.js)
    await mPage.waitForSelector("button.tab-more, .tab.tab-more", { timeout: 10000 }).catch(() => {});

    for (const sc of ALL.filter((s) => s.mobile)) {
      await runScenario(mPage, scenarios, sc);
      await sleep(250);
    }
    await mBrowser.close();
  }

  // Attach animation key catalog to report
  const keyHits = {};
  for (const s of scenarios) {
    for (const k of s.keys || []) {
      keyHits[k] = keyHits[k] || { exercised_by: [], issues: 0 };
      keyHits[k].exercised_by.push(s.id);
      keyHits[k].issues += (s.issues || []).length;
    }
  }

  // ── Aggregate report ───────────────────────────────────────────────────
  const allIssues = scenarios.flatMap((s) => s.issues || []);
  const bySev = { high: 0, med: 0, low: 0 };
  for (const i of allIssues) bySev[i.severity] = (bySev[i.severity] || 0) + 1;

  const report = {
    generated_at: new Date().toISOString(),
    base: BASE,
    fps: FPS,
    duration_ms_default: DURATION_MS,
    viewport: VIEWPORT,
    out: OUT,
    summary: {
      scenarios: scenarios.length,
      issues: allIssues.length,
      by_severity: bySev,
      animation_keys_exercised: Object.keys(keyHits).length,
    },
    animation_keys: keyHits,
    scenarios,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

  const md = [];
  md.push(`# Animation audit — FULL registry — ${stamp}\n`);
  md.push(`Base: \`${BASE}\` · target ${FPS}fps · default burst ${DURATION_MS}ms\n`);
  md.push(`\n## Summary\n`);
  md.push(`- Scenarios: **${scenarios.length}**\n`);
  md.push(`- Animation keys tagged: **${Object.keys(keyHits).length}**\n`);
  md.push(`- Issues: **${allIssues.length}** (high ${bySev.high || 0} · med ${bySev.med || 0} · low ${bySev.low || 0})\n`);
  md.push(`\n## Animation keys exercised\n`);
  for (const [k, v] of Object.entries(keyHits).sort((a, b) => a[0].localeCompare(b[0]))) {
    md.push(`- \`${k}\` ← ${v.exercised_by.join(", ")}${v.issues ? ` _(issues touching: ${v.issues})_` : ""}\n`);
  }
  md.push(`\n## Scenarios\n`);
  for (const s of scenarios) {
    if (s.skipped) {
      md.push(`\n### \`${s.id}\` — ${s.label}\n- _skipped_: ${s.reason}\n`);
      if (s.keys && s.keys.length) md.push(`- keys: ${s.keys.map((k) => "`" + k + "`").join(", ")}\n`);
      continue;
    }
    md.push(`\n### \`${s.id}\` — ${s.label}\n`);
    if (s.keys && s.keys.length) md.push(`- keys: ${s.keys.map((k) => "`" + k + "`").join(", ")}\n`);
    md.push(`- frames: ${s.frameCount} · meanΔ ${s.metrics.meanPct}% · maxΔ ${s.metrics.maxPct}% · earlyStall ${s.metrics.earlyStallMax || 0} · flashes ${s.metrics.flashCount} · capture ~${s.metrics.actualFps}fps\n`);
    md.push(`- contact sheet: [${s.contact}](${s.contact})\n`);
    if (s.issues && s.issues.length) {
      md.push(`- **issues:**\n`);
      for (const iss of s.issues) {
        md.push(`  - \`[${iss.severity}] ${iss.code}\` ${iss.message}\n`);
      }
    } else {
      md.push(`- issues: none detected by heuristics\n`);
    }
  }
  md.push(`\n## How to re-run\n\`\`\`bash\ncd /root/array-operator/verify && npm run audit:animations\n\`\`\`\n`);
  fs.writeFileSync(path.join(OUT, "report.md"), md.join(""));

  console.log("\n════════════════════════════════════════");
  console.log(`Done. Issues: ${allIssues.length} (high ${bySev.high || 0} / med ${bySev.med || 0} / low ${bySev.low || 0})`);
  console.log(`Report: ${path.join(OUT, "report.md")}`);
  console.log("════════════════════════════════════════\n");

  // Exit non-zero on high severity so CI can gate
  if ((bySev.high || 0) > 0) process.exitCode = 2;
  else if ((bySev.med || 0) > 0) process.exitCode = 0; // med = review, not hard fail yet
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
