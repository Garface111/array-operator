# Array Operator — Design Language

**Read this before ANY UI change.** This is the distilled taste of weeks of
Ford + agent iteration. It is not advisory. When a change conflicts with this
file, the change is wrong or this file gets updated in the same PR — never
silently diverge. (Deploy mechanics live in the memory fleet + `_redirects`;
this file is the *look, feel, and conduct* of the product.)

## The five laws

1. **Build the sublime version, integrated in place.** Never the minimal
   literal reading; never a bolt-on tab/modal/parallel mechanism. Before
   building, find the existing surface this belongs inside (sub-tab registry,
   sheet, drawer, chip row) and extend it.
2. **Features are implicit, not announced.** The UI shows; it does not narrate.
   Copy is one short action line, not a brochure paragraph listing what the
   module covers. If deleting a sentence still leaves a clear path, the
   sentence was noise. No tour-voice, no re-listing sibling tabs, no
   "This page does X and Y" lectures.
3. **Honest states, always.** Every surface ships loading / empty / error
   states. Loading must RESOLVE (timeout → honest error, never an eternal
   spinner). Empty = one true sentence + the single next action. Error = what
   happened + what to do, in owner words ("Couldn't load — retry" not raw
   HTTP). Never fabricate data; estimated values are visibly marked
   (confidence chips), measured values win.
4. **Dense, minimal, low-friction.** Fewest clicks; the obvious thing just
   works. Prefer density over whitespace theater. One idea per element —
   redundancy is a bug (title + lede + bullet saying the same thing three ways
   → cut to one).
5. **Motion is dolly, not scale.** Depth comes from moving the camera
   (slide/translate between panels, the tab-slide order), not from zooming or
   inflating elements. Micro-motion only; `prefers-reduced-motion` respected.

## Palette & materials

- **Day-mode ONLY.** No dark theme. The product is utility-blue on slate over
  the Sky photo world. Tokens live in `theme-day.css` + `theme-sky*.css` —
  use the existing custom properties; never invent hex values inline.
- **Sky material budget** (from the Sky redesign): backdrop-blur glass on
  TOP-LEVEL bands only (nav, sub-tab pill bar, sheet edges); content cards are
  near-solid (`~.86` alpha) so text never sits on mush. Everything content
  lives inside the safe-zone sheet; nothing floats naked on the photo.
  **Attach the sheet to the CONTAINER, never to one view's own wrapper.** In
  Marketplace it lives on `.mk-pane` (the per-sub pane every sub mounts into),
  so a new sub is inside the safe zone for free. It was pinned to `.mk-wrap` —
  a class only Credit Exchange rendered — which left Array Market and the REC
  desk floating on the photo until 2026-07-19. If you add a sheet, ask which
  element *every* view is guaranteed to have.
- **Octarine (violet) is the AI's signature — and ONLY the AI's.** Octarine
  marks Energy Agent presence/actions (Ask Energy Agent, agent chips, vacancy
  insights she computed). A human CRUD button is never octarine. If everything
  is octarine, nothing is.
- **Utility-blue** is the human primary-action color. Warm amber/red only for
  genuine warnings; success green sparingly.

## Components

- **One primary button per view.** A list never repeats a loud filled CTA on
  every row — rows get quiet actions (text-button or subtle outline); the ONE
  filled primary belongs to the view's single main act. (Counterexample that
  triggered this rule: eight solid-violet "Prepare prospectus" pills in a row.)
- **Sub-tabs are glass pills** (the `#rbGenTabs` / marketplace pattern) —
  registered into the shared registry, never a second nav mechanism.
- **Chips carry state** (fresh/stale, confidence, counts). A chip is one word
  or number+word; a chip that needs a sentence is a card.
- **Dialogs are AODialog** — never native `alert/confirm/prompt`.
- **Empty-state seed objects over blank walls**: show the shape of what will
  exist (ghost rows, sample card marked as sample) with the one action that
  fills it. Never fabricated live-looking data.

## Copy voice

Blunt, terse, owner-first. Verbs first ("Connect the host login", "Prepare
prospectus"), no marketing adjectives, no exclamation marks, no "please".
Numbers with units (`kWh`, `kW`, `$/kWh`) — never bare. Say "you/your fleet",
not "users". The agent speaks as **I**; the product never speaks as "we".

## States checklist (ship-gate for any new surface)

- [ ] Loading resolves within a visible timeout → honest error with retry
- [ ] Empty state: one true sentence + one next action
- [ ] Error state: owner-words + what to do (no raw status codes)
- [ ] Estimated vs measured visibly distinguished
- [ ] Works at 375px (mobile.css wins the cascade — check it)
- [ ] `?v=` token bumped IN THE SAME COMMIT for every touched asset
- [ ] One primary action; octarine only if the AI is acting
- [ ] Every new capability integrated into an existing surface (which one?)

## Mechanics that bite (short list)

- 7-stylesheet cascade; `mobile.css` loads last and wins.
- Every `?v=`-loaded asset change MUST bump the token in `index.html` in the
  same commit, or returning browsers replay stale code forever.
- A branch deploy is a GHOST deploy — the next main deploy erases it. Merge to
  main before believing anything is "live".
- Verify by curling the LIVE asset for your change's content, not by trusting
  the deploy log.
