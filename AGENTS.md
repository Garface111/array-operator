# Array Operator — agent rules

Owner site: `public/` (vanilla JS, Netlify). Backend: `solar-operator` Railway.

## Design framework (owner-facing)

**Voice:** concise, precise, professional.

**Features are implicit, not announced.**
- Teach by opening the real UI (tab, form, control). Do not inventory capabilities in prose.
- Copy = short action or state only. No product-map lectures, no feature lists next to the surface that already shows them.
- No redundant title + lede + bullets + callout stacks. One line beats three restatements.
- If deleting a sentence leaves a clear path (CTA + live page), delete it.

**Setup guide** (`public/hands-off-tour.js`): lean steps (title, optional one-line lede, CTA, live chip). Extend in that shape only.

**Deploy:** `python3 …/netlify_api_deploy.py` (or equivalent) — `git push` alone does not update arrayoperator.com. Cache-bust `?v=` on changed assets in `index.html`.

**Git:** stage only files you changed; never `git add -A` on the shared tree.
