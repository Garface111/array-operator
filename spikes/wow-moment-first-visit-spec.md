# Build spec — first-visit "arrays populate live" wow moment (AO dashboard)

Status: SPEC (assessed + designed, not yet built). Deferred because (a) the AO
netlify deploy is blocked on re-auth so nothing ships live, and (b) the change
lands in `public/sandbox.js` — the hot, multi-writer fleet renderer — where the
async-capture path can't be verified live without risking the main fleet view.
Build this once deploy is unblocked and on a quiet sandbox.js.

Pattern source: `saas-onboarding-wow-moment` skill (pillar 3 = live reveal,
pillar 4 = sequence the reveal). Founder's own words: "we really want that moment
of seeing all the arrays autopopulate."

## The gap (verified in code)

The real first-visit surface is the **sandbox** (`#sandbox`, `public/sandbox.js`).
app.js's `#grid`/`render()` is legacy dead code (index.html has no `#grid`).

- Data layer: `window.FleetStore` (`public/fleet-store.js`) — `FleetStore.refetch()`
  hits `GET /v1/array-owners/fleet-tree`; `renderFromStore()` re-renders.
- Empty state today: `sandbox.js` ~line 1245-1254, the "no arrays at all" branch:
  cold + administrative — `"No arrays connected yet — hit + Add array to bring
  your inverters in."`
- There IS a ~60s auto-refresh + refetch-on-connect, so arrays DO appear without
  a manual refresh — but up to ~60s late, and the interim copy is a dead-end.

A freshly-onboarded user (lands on `/?fresh=1`) whose arrays are still being
captured async (extension vendors: Chint/Fronius/SMA) sees the cold empty state
instead of watching their arrays arrive — the onboarding magic evaporates.

## The build (4 small pieces)

1. **Detect first-visit + in-flight capture.** `const fresh = new URLSearchParams(
   location.search).get('fresh') === '1';` Persist a `aoFreshUntil = Date.now()+
   90_000` in sessionStorage on first paint so the warm state survives the
   `?fresh=1` being stripped by a re-render.

2. **Warm "watching" empty state (only when fresh + within window).** In the
   no-arrays branch, if `fresh && Date.now() < aoFreshUntil`, render a warm state
   instead of the cold one:
   - Reuse the onboarding spinner aesthetic (`<span class="ring"></span>`).
   - Copy: "Watching for your arrays… sign in to your monitoring portal in the
     other tab and they appear here on their own — no refresh." (HONEST: backed by
     the poll below + refetch-on-connect.)
   - Keep a secondary "+ Add array" affordance for users who haven't connected.
   - After the window expires with still-zero arrays, fall through to today's
     cold state (which is correct for a genuinely-empty fleet).

3. **Accelerated first-visit poll (pillar 3).** A self-contained poller that does
   NOT disturb the existing 60s timer:
   ```js
   function pollFreshArrays() {
     let tries = 0;
     const tick = async () => {
       if (tries++ > 20 || Date.now() > aoFreshUntil) return; // ~60s @ 3s
       try {
         await FleetStore.refetch();
         const cols = (FleetStore.focusColumns().columns || []);
         if (cols.length) { renderFromStore(); revealNewArrays(); return; }
       } catch (_) {}
       setTimeout(tick, 3000);
     };
     setTimeout(tick, 3000);
   }
   ```
   Call it once from the no-arrays branch when `fresh`. Stops on first arrays
   landing. Cheap + self-limiting (≤20 calls, once per session).

4. **Reveal on the datum, not chrome (skill's key lesson).** When arrays land,
   `renderFromStore()` already paints them (sandbox expands all inverters on
   first visit — good). Add ONLY a subtle in-place entrance:
   - `.sb-col` gets a one-shot `@keyframes sb-arrive { from{opacity:0;
     transform:translateY(6px)} to{opacity:1;transform:none} }`, staggered by
     index via `animation-delay`. Respect `@media (prefers-reduced-motion:reduce)`
     (no transform, instant).
   - NO overlay, NO full-screen wash, NO headline card — the founder explicitly
     rejected overlay theatre; motion goes ON the arriving cards.

## Test plan (do before calling it done)

- Local: drive `sandbox.js` with a FleetStore stub that returns `[]` for the
  first 2 refetches then real columns; screenshot the warm state → the arrive
  animation → populated fleet (Playwright, like `scripts/shot_onboarding_states.py`).
- Live (after deploy): real signup → connect an extension vendor → land on
  `/?fresh=1` → watch arrays arrive within ~3-6s, not 60s, with no manual refresh.

## Guardrails

- Only fast-poll on `fresh` — never add continuous fast polling (battery/server).
- Warm copy must stay HONEST: only claim "appear on their own" because the poll +
  refetch-on-connect actually deliver it. If the poll is removed, revert the copy.
- sandbox.js is multi-writer: make the change localized to the empty-branch +
  one poller fn + one keyframe; commit immediately; rebase before push.
