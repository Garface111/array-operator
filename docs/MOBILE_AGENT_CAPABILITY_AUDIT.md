# Mobile “Ask Agent” capability audit

**Date:** 2026-07-21  
**Apps:** `apps/owner-web` (`/m`) · `apps/owner-native` (Expo RN)  
**Backend:** Energy Agent tools in `solar-operator` (`energy_agent.py` + `energy_agent_mobile_tools.py`)

## Every mobile CTA → tool path

| Screen | CTA / prompt (summary) | Tools used (live) | Status |
|--------|------------------------|-------------------|--------|
| Fleet | Needs eyes / attention | `investigate_attention` | ✅ Works |
| Fleet | Connect first array | `account_summary`, `setup_status` | ✅ Guides + missing capture |
| Fleet | Array focus | `array_detail` | ✅ Works |
| Fleet | Inverter help | `array_detail` | ✅ Works |
| Analysis | Fleet analysis brief | `investigate_attention`, `production_forecast` | ✅ Works |
| Invoices | Pipeline brief | `list_offtakers`, `send_pipeline`, `list_recent_invoices` | ✅ Works |
| Invoices | Add offtakers | **`create_offtaker`** (+ list) | ✅ **Built** (demo blocked) |
| Repairs | Command center / ticket focus | `repair_ops_overview`, `investigate_attention` | ✅ Works |
| Marketplace | Vacancy | **`marketplace_vacancy`** | ✅ **Built** |
| Marketplace | Capture demand | **`list_exchange_demand`**, **`create_exchange_demand`** | ✅ **Built** |
| Account | Plan / billing / auto-refresh | `account_summary`, `capture_health_detail`, `product_map` | ✅ Works |
| Account | Connect arrays / auto-refresh / utility / Stripe | setup + **`payments_connect_status`** / **`start_payments_connect`** | ✅ **Built** |

## Gaps found → fixed

1. **No `create_offtaker` tool** — agent only pointed at desktop bulk import.  
   → Added `create_offtaker` (confirm-aware, demo-safe).
2. **No vacancy engine tool** — agent inferred 0 offtakers = 100% vacancy without `market_vacancy`.  
   → Added `marketplace_vacancy`.
3. **No exchange demand tools** — capture-demand prompt used **zero tools**.  
   → Added `list_exchange_demand` + `create_exchange_demand`.
4. **No Stripe Connect status tool** — only generic `account_summary`.  
   → Added `payments_connect_status` + `start_payments_connect`.
5. **Mobile UI** could not confirm writes or open Stripe URLs.  
   → `/m` AgentSheet: Yes/Cancel pending + tool chips + `open_url`.  
   → RN: `AgentModal` + header Agent button + context for seeded prompts.

## Honest limits (not bugs)

- **Portal login / extension capture** cannot be completed inside chat alone (needs browser extension or Account vault). Agent correctly uses `setup_status` / `capture_health_detail` and explains Paths A/B/C.
- **Demo tenant** blocks create offtaker / demand / Stripe start (`demo_blocked`) — intentional.
- **Deep offtaker editor** (bulk file upload, full bill audit UI) still lives on desktop Invoices; agent can create single offtakers and patch fields via tools.

## Re-verify (prod, after deploy `a605e969`)

```
marketplace_vacancy → tools=['marketplace_vacancy'] 200
capture_demand      → tools=['list_exchange_demand'] 200
add_offtakers       → tools=['create_offtaker',…] demo_blocked 200
stripe_connect      → tools=['payments_connect_status'] 200
```
