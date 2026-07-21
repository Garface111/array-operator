# Array Operator — React Native (Expo)

**True React Native** clone of the Array Operator owner product (desktop tabs +
sky theme + live API). This is **not** the web SPA at `arrayoperator.com/m`
(`apps/owner-web`) and **not** the Capacitor shell around that SPA.

| | |
|---|---|
| **Path** | `apps/owner-native` |
| **Stack** | Expo SDK 57 · Expo Router · React Native 0.86 |
| **API** | `https://arrayoperator.com` (`so_session` / SecureStore) |
| **Tabs** | Fleet · Analysis · Invoices · Repairs · Market · Account |

## Run on your phone

```bash
cd apps/owner-native
npm install
npx expo start
```

- Scan the QR code with **Expo Go** (iOS/Android), or
- `npx expo start --android` / `--ios` with a simulator/emulator
- `npx expo start --web` for a quick browser smoke test of the RN tree

Sign in with the same Array Operator email/password as the website.

## What’s ported

- **Fleet** — KPI strip, Cards | Table, output gauges, sparklines, power bars,
  expandable inverters (vendor-table style)
- **Analysis** — fleet trend + site ranking by health/peer
- **Invoices** — send-pipeline KPIs + offtaker list (`list-bundle`)
- **Repairs** — attention queue from live fleet health
- **Marketplace** — live array/offtaker counts
- **Account** — profile + connect-feed checklist + sign out
- **Auth** — password login + magic-link request; session in SecureStore

## Not yet (desktop still deeper)

- Sandbox drag canvas / full offtaker editor / bill audit deep tools
- Energy Agent chat sheet
- Native push notifications

## Relation to other clients

| Client | Tech | Ships |
|--------|------|--------|
| `public/` | Vanilla JS | arrayoperator.com desktop |
| `apps/owner-web` | React + Vite (+ optional Capacitor) | `/m` phone web |
| **`apps/owner-native`** | **React Native (Expo)** | **Store / Expo Go** |

## Typecheck

```bash
npx tsc --noEmit
```
