# Invoices · Offtakers — landing redesign (2026-07-28)

**PICKED (Ford, 2026-07-28, iterated twice): Directory + Rail with the
hierarchy Data source → Array → Offtaker.** Open `index.html` — the pick is
the default view (★); earlier directions remain as alternates (keys 1–4).

## The picked design — spec (Ford's words, distilled)

- **Hierarchy: Data source → Array → Offtaker.** Top level = the data source
  (the master utility account whose bill is pulled: GMP #08211-3, VEC
  #40122-7, plus a "No data source yet" bucket). Arrays nest under the source
  that feeds them; offtakers under arrays. The utility-ACCOUNT grouping level
  from the old provider→account→offtaker accordion is gone; the account
  identity lives on the source header and on each array's tether chip.
- **Tether button per array** — binds the array to the master account bill
  pulled for it (untethered arrays sit under "No data source yet" with a
  dashed "Tether to master bill" CTA; invoices can't draft until tethered).
- **The offtaker EDITING LEVEL IS NOT REDESIGNED** (Ford: "I don't want that
  level of editing to be changed, only the top-down picture"). The mockup
  reproduces the live editor verbatim from Ford's screenshot: head chips
  ($ ready · Delivered · Paid online · Auto-send), the receives-% sentence,
  next/last sent, delete; billing-period picker; "Receives 15% · period ·
  $ due"; **Approve & send / Send to me / Preview ↗**; the five tinted
  sections (How this was calculated · Offtaker details · Edit email ·
  Invoice template · Generation spreadsheet); the live email preview
  (FROM/TO/SUBJECT + body + billing table).
- **The rail MINIMIZES while an offtaker editor is open** (Ford: "too cramped
  when the preview is displayed"). Opening an offtaker collapses the right
  rail to a 60px icon strip (badge = N to approve, add/export/email/archive
  icons, « restores); closing the editor brings the full rail back. While the
  full rail is expanded during editing, the preview stacks below the sections
  instead of cramping. This interaction is LIVE in the mockup — click Town of
  Glover's header.
- **Send-pipeline band deleted.** Essentials live in the rail: N to approve +
  Review & approve, June delivered line, auto/waiting counts, next run,
  delivery-mode slider, bill health → Bill audit, all tools.
- **Master credit rate = small chip in the "Your offtakers" bar.**

Sky theme verbatim (`theme-sky.css` tokens; blur budget respected; amber =
review flag, emerald = positive; paper stays paper for the email preview).

## Implementation notes

- Re-frame `shell()` + `renderAccordion()` in `public/reports.js`: group
  offtakers by data source (master utility account) → array (`array_id`) →
  offtaker. Remove the `.rb2-pipe` render. Add the rail (grid inside `.rb2`)
  with an `editing` state toggled by the offtaker open-card (`.rb-acc
  [data-open]`) that collapses the rail to the mini strip.
- The offtaker open-card editor (calc/details/email/template/spreadsheet
  sections + live preview + Approve & send / Send to me / Preview) is
  UNTOUCHED — same DOM, same wiring.
- Follow-on pass in `theme-sky-reports.css`; bump `?v=` tokens in
  `public/index.html` in the SAME commit; deploy only via
  `scripts/deploy-and-verify.sh`. Read DESIGN.md first.

## Earlier directions (kept for reference on the switcher)

A. **Array-first stack** — array-first as a single column, no rail.
1. **One Question First** — hero leads with what needs approval.
2. **The Pipeline Is the Page** — pipeline as a vertical timeline.
