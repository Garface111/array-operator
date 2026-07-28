# Invoices · Offtakers — landing redesign (2026-07-28)

**PICKED (Ford, 2026-07-28): Directory + Rail, rebuilt array-first.** Open
`index.html` — the pick is the default view (★); the three earlier directions
remain as alternates on the switcher (keys 1–4).

## The picked design — spec (Ford's words, distilled)

- **Organize by ARRAY first.** Top level of the list = arrays (not utility
  accounts — that grouping level is removed). Click an array → its offtakers
  expand beneath, like today. Click an offtaker → the EXISTING editing system
  opens in place (how-this-was-calculated, offtaker details, edit email, etc.,
  with the live invoice preview on the right). That editor is good — keep it.
- **Delete the send-pipeline visual** (`.rb2-pipe`) — too busy. Its essentials
  survive in the sticky right rail: "N to approve" + approve button, June
  delivered line, auto/waiting counts, next-run date, and the delivery-mode
  slider.
- **Master solar credit rate → a small chip in the "Your offtakers" bar.**
- **Tether button per array row** — binds the array to the master account
  bill pulled for it. Tethered state shows the account + settled month
  ("🔗 GMP #08211-3 · Jun ✓"); untethered shows a dashed "Tether to master
  bill" CTA.
- **Right rail** (from direction 3): cycle card (count + $ + Review & approve),
  mode + bill-health card (reconcile status → Bill audit), and all tools as a
  quiet link list (Add / Bulk import / Export / Customize email / Link utility
  bills / Archive).

Landing-only reorganization; deeper flows unchanged. Sky theme verbatim
(`theme-sky.css` tokens; amber = review flag, emerald = positive, blur budget
respected: glass on top-level bands, near-solid repeated cards, paper stays
paper for the invoice preview).

## Implementation notes

- Re-frame `shell()` + `renderAccordion()` in `public/reports.js`: group by
  `array_id` instead of provider → utility-account; the account identity moves
  into the array row's tether button. Remove the `.rb2-pipe` render; add the
  rail (new top-level flex/grid inside `.rb2`).
- The offtaker open-card editor (`.rb-acc[data-open]` + folded template box +
  preview) is untouched.
- Follow-on pass in `theme-sky-reports.css`; bump the `?v=` tokens in
  `public/index.html` in the SAME commit; deploy only via
  `scripts/deploy-and-verify.sh`. Read DESIGN.md first.

## Earlier directions (kept for reference)

1. **One Question First** — hero leads with what needs approval; pipeline
   compressed to a status line; tools folded into ⋯.
2. **The Pipeline Is the Page** — pipeline cells as a vertical timeline with
   approval rows inline; directory collapsed below.
3. **Directory + Rail (v1, utility-grouped)** — superseded by the pick.
A. **Array-first stack** — the array-first spec as a single column, no rail.
