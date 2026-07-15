# Store screenshots (Array Operator mobile)

App Store and Google Play need device-framed or clean phone screenshots.
Target size for phone listings: **390 × 844** (iPhone 14 / common Android
logical viewport). Also useful: **1170 × 2532** @3x for App Store raw assets.

## What to capture

Recommended set (5–8 shots):

| # | Screen | Route / notes |
|---|--------|----------------|
| 1 | Home / fleet pulse | `/m/fleet` — production, status cards |
| 2 | Fleet tree | Expand an array / inverter detail |
| 3 | Energy Agent | Open agent sheet with a sample reply |
| 4 | Invoices / offtakers | `/m/invoices` roster + one detail |
| 5 | Connect | `/m/connect` vendor / SolarEdge state |
| 6 | Analysis (if wired) | Trends / forecast cards |
| 7 | Login | `/m/login` branded sign-in (optional) |

Use a **demo or dogfood account** so no real customer PII appears.

## Option A — From existing dogfood output

Dogfood runs often write under:

```text
apps/owner-web/dogfood-output/
apps/owner-web/preview-shots/
```

Copy any full-page mobile shots, then crop or re-export to **390×844**:

```bash
cd apps/owner-web
# list recent shots
find dogfood-output preview-shots -type f \( -name '*.png' -o -name '*.jpg' \) | head

# resize / pad a shot to store size (ImageMagick)
convert dogfood-output/SOME.png -resize 390x844^ -gravity center -extent 390x844 \
  store/screenshots/01-fleet.png
```

## Option B — Live site with Playwright (preferred)

Live mobile beta: **https://arrayoperator.com/m/**

```bash
cd apps/owner-web
npx playwright install chromium   # once

# Capture 390×844 PNGs into store/screenshots/
node --input-type=module <<'EOF'
import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';

const OUT = new URL('./store/screenshots/', import.meta.url);
await mkdir(OUT, { recursive: true });

const shots = [
  { name: '01-login', path: '/m/login' },
  { name: '02-fleet', path: '/m/fleet' },
  { name: '03-invoices', path: '/m/invoices' },
  { name: '04-connect', path: '/m/connect' },
  { name: '05-more', path: '/m/more' },
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2, // 780×1688 physical; stores accept @2x
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();

// Optional: inject session cookie so authenticated screens work
// await context.addCookies([{ name: 'so_session', value: process.env.SO_SESSION, domain: 'arrayoperator.com', path: '/' }]);

for (const s of shots) {
  await page.goto('https://arrayoperator.com' + s.path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const file = new URL(`${s.name}.png`, OUT);
  await page.screenshot({ path: file.pathname, fullPage: false });
  console.log('wrote', file.pathname);
}

// Energy Agent: open sheet on fleet if UI exposes a control
// await page.goto('https://arrayoperator.com/m/fleet');
// await page.getByRole('button', { name: /agent/i }).click();
// await page.screenshot({ path: new URL('06-agent.png', OUT).pathname });

await browser.close();
EOF
```

### Authenticated captures

1. Sign in in a browser, copy the `so_session` cookie, export as `SO_SESSION`.
2. Uncomment the `addCookies` line above, or log in via UI in the script
   (`page.fill` email/password → submit) before the shot loop.
3. Prefer demo mode / sample offtakers if the account supports it.

### Local dev instead of production

```bash
npm run dev   # http://localhost:5174/m/
# Point Playwright at http://localhost:5174 instead of arrayoperator.com
```

## Option C — Capacitor device / simulator

After `npx cap sync` and run on simulator:

- iOS Simulator → Device → Screenshots (or Cmd+S)
- Android emulator → camera toolbar / `adb exec-out screencap -p`

Resize to store requirements in App Store Connect / Play Console upload UIs
if the raw dump is not 390×844.

## Checklist before upload

- [ ] No real customer names, emails, or meter IDs
- [ ] Status bars consistent (or use Play/App Store framing tools)
- [ ] Text legible at thumbnail size
- [ ] Light mode (or both light + dark if product supports both)
- [ ] Files named `01-…png` … in this folder for easy ordering

## Capacitor asset generation (icons / splash)

Icons and splash live in `apps/owner-web/resources/`:

- `icon.png` — 1024×1024
- `icon-foreground.png` — 1024×1024 adaptive foreground
- `splash.png` — 2732×2732

After changing them:

```bash
# if @capacitor/assets is configured
npx @capacitor/assets generate --iconBackgroundColor '#1E90E8' --splashBackgroundColor '#f0f9ff'
```
