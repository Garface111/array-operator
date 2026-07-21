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
  // Early stall: freeze BEFORE any real motion in the first ~450ms (true jank).
  // Post-animation stillness is expected settle and is NOT a freeze bug.
  let earlyStall = 0, earlyStallMax = 0, sawMotion = false;
  for (let k = 0; k < diffs.length; k++) {
    if (diffs[k].t > 450) break;
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

  // Expected motion but almost none
  if (exp.expectMotion && m.motionFrames < 2 && m.maxPct < 0.4) {
    issues.push({
      severity: "high",
      code: "NO_MOTION",
      message: `Expected animation but saw almost no frame change (maxΔ=${m.maxPct}%, motionFrames=${m.motionFrames}).`,
    });
  }

  // Stall before motion starts (jank). Settle freezes after the slide are OK.
  if (exp.expectMotion && (m.earlyStallMax || 0) >= Math.ceil(FPS * 0.4) && m.maxPct > 1) {
    issues.push({
      severity: "med",
      code: "EARLY_STALL",
      message: `Animation stalled ${m.earlyStallMax} frames before motion began (maxΔ=${m.maxPct}%). Possible delayed start/jank.`,
    });
  }

  // Flash / single-frame pop
  if (m.flashCount > 0) {
    issues.push({
      severity: "med",
      code: "FLASH",
      message: `${m.flashCount} single-frame flash(es) detected (large one-frame jump then quiet).`,
    });
  }

  // Never settles — tail still thrashing hard
  if (exp.expectSettle !== false && m.tailMeanPct > 3.5 && m.maxPct > 5) {
    issues.push({
      severity: "med",
      code: "NO_SETTLE",
      message: `Animation may not settle: last-20% meanΔ=${m.tailMeanPct}% (still moving hard at end of capture).`,
    });
  }

  // Continuous marquee: need ongoing motion, not a one-shot
  if (exp.continuous && m.motionFrames < Math.floor(burst.frameCount * 0.35)) {
    issues.push({
      severity: "high",
      code: "MARQUEE_STALLED",
      message: `Continuous motion expected (marquee) but only ${m.motionFrames}/${burst.frameCount} frames moved.`,
    });
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

async function runScenario(page, scenarios, { id, label, setup, act, expect, durationMs }) {
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

  // ── Tab-slide animations (top bar) ─────────────────────────────────────
  const tabs = [
    { id: "tab-analysis", hash: "#analysis", sel: "#tabAnalysis, a.tab[href='#analysis']" },
    { id: "tab-reports", hash: "#reports", sel: "#tabReports, a.tab[href='#reports']" },
    { id: "tab-ops", hash: "#ops", sel: "#tabOps, a.tab[href='#ops']" },
    { id: "tab-marketplace", hash: "#marketplace", sel: "#tabMarketplace, a.tab[href='#marketplace']" },
    { id: "tab-account", hash: "#account", sel: "#tabAccount, a.tab[href='#account']" },
    { id: "tab-fleet", hash: "#dashboard", sel: "#tabDashboard, a.tab[href='#dashboard']" },
  ];

  // Start on fleet
  await gotoHash(page, "#dashboard");
  await sleep(800);

  for (const t of tabs) {
    await runScenario(page, scenarios, {
      id: t.id,
      label: `Top-tab navigate → ${t.hash}`,
      act: async (p) => {
        const clicked = await safeClick(p, t.sel);
        if (!clicked) await gotoHash(p, t.hash);
      },
      expect: { expectMotion: true, expectSettle: true },
      durationMs: 1600, // tab-slide is ~500ms; capture pad
    });
    await sleep(400);
  }

  // ── Fleet sub-views ────────────────────────────────────────────────────
  await gotoHash(page, "#dashboard");
  await sleep(600);
  for (const [id, sel, label] of [
    ["fleet-table", "a[href='#arrays'], button:has-text('Table'), .vs-seg-btn:has-text('Table'), [data-view='table']", "Fleet → Table"],
    ["fleet-sandbox", "a[href='#sandbox'], button:has-text('Sandbox'), .vs-seg-btn:has-text('Sandbox')", "Fleet → Sandbox"],
    ["fleet-triage", "a[href='#dashboard'], button:has-text('Triage'), .vs-seg-btn:has-text('Triage')", "Fleet → Triage"],
  ]) {
    await runScenario(page, scenarios, {
      id,
      label,
      act: async (p) => {
        if (!(await safeClick(p, sel))) {
          // hash fallbacks
          if (id === "fleet-table") await gotoHash(p, "#arrays");
          else if (id === "fleet-sandbox") await gotoHash(p, "#sandbox");
          else await gotoHash(p, "#dashboard");
        }
      },
      expect: { expectMotion: true },
      durationMs: 1200,
    });
  }

  // ── Energy Agent open / close ──────────────────────────────────────────
  await gotoHash(page, "#dashboard");
  await sleep(500);
  await runScenario(page, scenarios, {
    id: "ea-open",
    label: "Open Energy Agent panel",
    act: async (p) => {
      // Orb / fab / programmatic
      const clicked =
        (await safeClick(p, "#eaOrb")) ||
        (await safeClick(p, "#eaFab")) ||
        (await safeClick(p, "[data-ea-open]")) ||
        (await safeClick(p, ".ea-orb, .ea-fab"));
      if (!clicked) {
        await p.evaluate(() => {
          if (typeof window.__eaOpen === "function") window.__eaOpen();
          else {
            const panel = document.getElementById("eaPanel");
            if (panel) {
              panel.classList.add("open");
              panel.hidden = false;
            }
          }
        });
      }
    },
    expect: { expectMotion: true, expectSettle: true },
    durationMs: 1400,
  });

  // Marquee continuous motion (only if suggestions visible)
  const marqueeVisible = await page.evaluate(() => {
    const el = document.getElementById("eaSuggestions");
    if (!el || el.hidden || el.classList.contains("ea-suggestions-gone")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 10;
  });
  if (marqueeVisible) {
    await runScenario(page, scenarios, {
      id: "ea-marquee",
      label: "EA suggestion marquee continuous scroll (idle observe)",
      act: async () => {}, // pure observe
      expect: { expectMotion: true, continuous: true, expectSettle: false },
      durationMs: 2200,
    });
  } else {
    console.log("\n⏭ ea-marquee — skipped (suggestions already dismissed this session)");
    scenarios.push({
      id: "ea-marquee",
      label: "EA suggestion marquee",
      skipped: true,
      reason: "suggestions not visible",
      issues: [],
    });
  }

  // Next-step chips appear after a synthetic agent bubble (local inject for motion)
  await runScenario(page, scenarios, {
    id: "ea-next-steps-inject",
    label: "EA next-step chips appear under a reply",
    act: async (p) => {
      await p.evaluate(() => {
        const host = document.getElementById("eaMsgs");
        if (!host) return;
        // Simulate agent reply + next steps if helper exists
        const msg = document.createElement("div");
        msg.className = "ea-msg agent";
        msg.setAttribute("data-role", "agent");
        msg.innerHTML = '<div class="ea-msg-body">Audit probe: fleet looks mostly healthy. Want a hard pass next?</div>';
        host.appendChild(msg);
        if (typeof window.__eaShowNextSteps === "function") {
          window.__eaShowNextSteps("fleet healthy. invoice and repair options.", "audit");
        } else {
          // Fallback local chips matching production markup
          const row = document.createElement("div");
          row.className = "ea-next-steps";
          row.innerHTML =
            '<div class="ea-next-steps-lbl">Next steps</div>' +
            '<div class="ea-next-steps-row">' +
            '<button type="button" class="ea-next-chip">Hardest problem first</button>' +
            '<button type="button" class="ea-next-chip">Who needs invoices?</button>' +
            '<button type="button" class="ea-next-chip">Dig deeper</button>' +
            "</div>";
          host.appendChild(row);
          host.scrollTop = host.scrollHeight;
        }
      });
    },
    expect: { expectMotion: true, expectSettle: true },
    durationMs: 900,
  });

  // Close EA
  await runScenario(page, scenarios, {
    id: "ea-close",
    label: "Close Energy Agent panel",
    act: async (p) => {
      const clicked =
        (await safeClick(p, "#eaClose, .ea-close, [data-ea-close]")) ||
        (await safeClick(p, "#eaOrb"));
      if (!clicked) {
        await p.evaluate(() => {
          if (typeof window.__eaClose === "function") window.__eaClose();
          else {
            const panel = document.getElementById("eaPanel");
            if (panel) {
              panel.classList.remove("open");
              panel.hidden = true;
            }
          }
        });
      }
    },
    expect: { expectMotion: true },
    durationMs: 1200,
  });

  // ── Analysis sub-segments if present ───────────────────────────────────
  await gotoHash(page, "#analysis");
  await sleep(900);
  const anSubs = await page.locator("[data-ansub], .an-sub, .vs-seg-btn").count();
  if (anSubs > 1) {
    await runScenario(page, scenarios, {
      id: "analysis-subnav",
      label: "Analysis sub-nav click",
      act: async (p) => {
        const n = await p.locator("[data-ansub], .an-subbtn, .vs-seg-btn").count();
        if (n > 1) await p.locator("[data-ansub], .an-subbtn, .vs-seg-btn").nth(1).click({ timeout: 3000 }).catch(() => {});
      },
      expect: { expectMotion: true },
      durationMs: 1100,
    });
  }

  await browser.close();

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
    },
    scenarios,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

  const md = [];
  md.push(`# Animation audit — ${stamp}\n`);
  md.push(`Base: \`${BASE}\` · target ${FPS}fps · burst ${DURATION_MS}ms\n`);
  md.push(`\n## Summary\n`);
  md.push(`- Scenarios: **${scenarios.length}**\n`);
  md.push(`- Issues: **${allIssues.length}** (high ${bySev.high || 0} · med ${bySev.med || 0} · low ${bySev.low || 0})\n`);
  md.push(`\n## Scenarios\n`);
  for (const s of scenarios) {
    if (s.skipped) {
      md.push(`\n### \`${s.id}\` — ${s.label}\n- _skipped_: ${s.reason}\n`);
      continue;
    }
    md.push(`\n### \`${s.id}\` — ${s.label}\n`);
    md.push(`- frames: ${s.frameCount} · meanΔ ${s.metrics.meanPct}% · maxΔ ${s.metrics.maxPct}% · freeze ${s.metrics.freezeMaxStreak} · flashes ${s.metrics.flashCount} · capture ~${s.metrics.actualFps}fps\n`);
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
  md.push(`\n## How to re-run\n\`\`\`bash\ncd /root/array-operator/verify && node animation-audit.mjs\n\`\`\`\n`);
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
