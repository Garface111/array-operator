# Array Operator — Surface Atlas

Ground-truth capture of every major owner-facing state on arrayoperator.com.

## Files
| Path | Role |
|------|------|
| `shots/*.png` | Viewport/full-page screenshots (demo session, 1440×900) |
| `manifest.json` | Per-state DOM inventory + navigation edges |
| `capture.mjs` | Re-runnable Playwright walker |
| `../../solar-operator/api/energy_agent_surface_model.md` | **Desktop mind memory** — micro/meso/macro model via `product_map(topic=surface…)` |
| `../../solar-operator/api/energy_agent_mobile_surface_model.md` | **Mobile mind memory** — owner-web `/m` + React Native via `product_map(topic=surface_mobile…)` |

## Re-capture
```bash
cd /tmp/ao-surface && npm install playwright --no-save
# Chromium already cached under ~/.cache/ms-playwright on this box
node /root/array-operator/docs/surface-atlas/capture.mjs
```
Uses `GET /v1/demo/enter` for a signed-in demo session.

## After re-capture
1. Vision-review new shots if UI changed materially.
2. Update `energy_agent_surface_model.md` MICRO lists if controls moved.
3. Deploy solar-operator so `product_map` serves the new model.

## Mental model levels
- **Macro** — why the page exists in the product
- **Meso** — owner’s goal on that visit  
- **Micro** — real controls (selectors / labels only)
