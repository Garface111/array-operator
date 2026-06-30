# Onboarding sync — the verification loop

The closed loop for the "find every array I own" onboarding sync. It exists because the Chint
debugging saga had **no automated verification step** — every fix was: edit → deploy → Ford
tests by hand → reports failure → repeat. This removes Ford as the manual oracle for the part
of the experience that can be made into rules.

## The three layers (and what each can actually verify)

You can't verify a *user experience* without a subject having one. So "verify" is split:

| Layer | What it checks | Subject needed? | Lives where |
|-------|----------------|-----------------|-------------|
| **1. Invariants** | The experience didn't *regress* — all vendors found, Chint opens solo, no eternal spinner, capture beats a false sign-out | **No** — runs anywhere, no creds | `onboarding-sync.mjs` (this harness) |
| **2. Synthetic subject** | Looks/feels right — broken layout, "feels slow", confusing copy | A vision model, no human | the screenshot this harness drops + an agent pass (below) |
| **3. Real capture + taste** | The actual extension pulls real arrays; the "wow" lands | Ford's browser + sessions; Ford's taste | live Claude-in-Chrome procedure (below) |

Layer 1 is the only one that closes fully headless. Layers 2–3 need a subject by definition —
the loop's job there is to *preserve* a judgment Ford already made, not to make it for him.

## Layer 1 — run it

```bash
cd verify
npm install                 # reuses the Chromium already cached by Playwright
npm run verify              # headless, against live prod (arrayoperator.com/onboarding)
npm run verify:headed       # watch it drive the page
ONB_URL=http://localhost:8080/onboarding npm run verify   # against a local copy
```

Exit `0` = every invariant holds. Non-zero = a regression. It drops a full-page screenshot of
the settled "all arrays" state to `artifacts/onboarding-happy.png` for Layer 2.

### What it asserts (each = a bug we fixed, now frozen)

1. **Happy path** — SolarEdge 3 + Fronius 2 + SMA 2 + Chint 1 → all tiles `found`, tally `8 arrays`, no spinner left.
2. **Chint sequencing** — Chint's portal opens **only after** the fast vendors settle, **never** at the old concurrent ~900ms (that concurrency caused the false `login_required` hang).
3. **No eternal spinner** — a Chint that never captures resolves to a clickable **"Sign in to add"**, never a frozen "signing in…".
4. **Capture wins** — a false `login_required` during sign-in never blocks a capture that follows; the tile still ends `found`.

It is **credential-free**: it replays the extension's `SO_EXTENSION_PRESENT` / `SO_CAPTURE_LANDED`
/ `SO_LOGIN_STATE` messages through the page's own same-origin channel. It verifies the page
**logic** — where every Chint bug actually lived — not real capture.

### Wire it into the loop

- **Deploy gate** — after the onboarding deploys, run `npm run verify`; a non-zero exit means the
  deploy regressed the sync. (Not auto-wired — the deploy pipeline is left untouched on purpose.)
- **Scheduled** — run it on a cron against prod to catch drift (extension contract changes, etc.).
- **Role separation** — run it as a *different* agent from the one that wrote the change, so the
  builder never grades its own work. This is the check that would have caught the `#/pv/sites`
  regression in 30 seconds instead of a screenshot from Ford.

## Layer 2 — synthetic subject (vision judge)

Feed `artifacts/onboarding-happy.png` (and headed step screenshots) to a vision model with:
*"Is this onboarding state confusing, broken, or slow-feeling? Flag anything that wouldn't feel
right to a first-time solar operator."* Catches looks-and-feel regressions a DOM assertion can't.
Keep it out of the headless harness (needs an API key) — run it as an agent step.

## Layer 3 — real capture + taste (live, on demand)

The irreducible part: the extension actually pulling real arrays, and the wow landing. Needs
Ford's browser (extension loaded + vendor sessions) — can't run unattended. Codified procedure:

1. Open `arrayoperator.com/onboarding` in Ford's Chrome with the extension loaded.
2. Inject a message recorder, then run the real sync:
   ```js
   window.__log = [];
   addEventListener("message", e => { const d=e.data; if (d&&/SO_|CAPTURE|LOGIN|PORTAL|SYNC/.test(d.type||"")) __log.push({ms:Date.now(), t:d.type, p:d.provider||d.vendor, s:d.state}); }, true);
   startSyncAll();
   ```
3. After ~20s read `state.syncStatus` — assert every vendor `found`, arrays > 0 — and confirm the
   Chint tab closed and focus returned. `__log` is the flight recorder if anything stalls.

This is the layer Ford blessed once ("you did it") — the loop's job is to keep run #2…#1000
matching the run he approved.
