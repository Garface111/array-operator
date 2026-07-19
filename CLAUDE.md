# Array Operator — agent entry point

**Before ANY UI/UX change: read [DESIGN.md](DESIGN.md).** It is the distilled
design language of this product (laws, palette, components, copy voice, state
checklist). Changes that conflict with it are wrong, or DESIGN.md gets updated
in the same commit — never silently diverge.

Hard mechanics (bite hardest, repeat here on purpose):

- **Shared multi-writer tree.** Never `git add -A`. Stage only your files,
  commit immediately, `git pull --rebase --autostash`. Verify with
  `git show HEAD:<file> | grep <marker>` — a commit message is not proof the
  content shipped.
- **Every `?v=`-loaded asset change bumps its token in `public/index.html` in
  the SAME commit**, or returning browsers replay stale code indefinitely.
- **Branch deploys are ghost deploys.** The deploy script ships the tree's
  HEAD; the next main deploy erases anything unmerged. Merge to main before
  calling it live.
- **Netlify is NOT git-linked.** Deploy = `scripts/deploy-and-verify.sh`
  (archives committed HEAD, gates on the Playwright onboarding loop). Verify by
  curling the LIVE asset for your change's content.
- Frontend map, deploy playbook, and deeper traps live in the CC fleet memory
  (`array-operator-frontend-map`, `deploy-playbook`,
  `concurrent-writers-energyagent-repos`).
