# Invoices · Offtakers — landing redesign, 3 sky-glass directions (2026-07-28)

Ford's read on the current landing: overwhelming and busy. Today the tab stacks
three dense glass bands (`shell()` in `public/reports.js` → the `.rb2` world):
the header band (h1 + honesty line + Offtakers/Bill-audit pills + reconcile
glance), the send-pipeline band (rules microcopy + mode slider + 3 cells × 3
chips each), and the list band (5-action toolbar + search/filter + the
provider → account → offtaker accordion + archive host).

This sketch reorganizes ONLY the landing. Deeper functionality — offtaker
cards/drawers, add/bulk/export/email-studio flows, bill audit, archive,
pipeline logic — is untouched; every existing surface keeps an entry point.
All three run the sky theme verbatim (`theme-sky.css` tokens: white glass,
#2196F3 action blue, 22/32px radii, blur(18px) saturate(1.7); amber = review
flag, emerald = positive, provider hue spines preserved).

Open `index.html` in a browser (or the published artifact) — top switcher,
keys 1/2/3. Same sample fleet in all three (24 offtakers, GMP + VEC,
3 awaiting approval, 1 audit flag).

## The three directions

1. **One Question First** — the landing opens with the only thing that needs
   the operator ("3 invoices need your approval" + one primary button). The
   whole pipeline band compresses to a single status line (June ✓ · auto/
   waiting counts · next run + mode chip). Toolbar collapses to ＋ Add and a
   ⋯ Tools popover (Export / Email / Link / Bulk / Archive). Directory below,
   unchanged.

2. **The Pipeline Is the Page** — the three pipeline cells become a vertical
   timeline with a spine: June folded, THIS CYCLE expanded with the approval
   rows inline (review/approve straight from the landing), next run folded
   (mode slider lives inside it). The directory is its own sheet, collapsed
   to provider headers.

3. **Directory + Rail** — the offtaker directory IS the page (search, GMP/
   Other filter, accordion); everything operational moves to one sticky rail:
   cycle card (count + $ + approve button + mini pipeline), mode + bill-health
   card, and all tools as a quiet link list.

## Shared principles

- The pipeline's honesty rules survive verbatim ("Nothing sends until you
  approve it", the auto-send exception wording, honest chip splits).
- Status is stated once per fact — no more chip + cell + subline restating.
- Amber/emerald/octarine semantics and per-provider hues pass through.
- Implementation is a re-frame of `shell()` + the pipe/list renderers in
  `public/reports.js` and a follow-on pass in `theme-sky-reports.css`; no
  backend or endpoint changes.
