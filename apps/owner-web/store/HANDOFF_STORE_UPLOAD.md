# Array Operator — App Store upload handoff

**Prepared:** 2026-07-15  
**Branch:** `feat/owner-react` (array-operator repo)  
**App ID:** `com.arrayoperator.app`  
**Version:** 1.0.0 (versionCode 1)

This is the **same React app** as https://arrayoperator.com/m — native Capacitor shells for Play Store + App Store. Login uses the **same `so_session`** + `/v1/*` backend as web, so offtakers/fleet/billing all link.

---

## What’s ready for Ford at wake-up

| Deliverable | Path / status |
|-------------|----------------|
| Android project | `apps/owner-web/android/` |
| iOS Xcode project | `apps/owner-web/ios/` (needs Mac to archive) |
| Release keystore | `store/signing/array-operator-release.jks` (**600**, not in git) |
| Keystore passwords | `store/signing/KEYSTORE.pass` (**600**, not in git) — **back up offline** |
| Privacy policy (live) | https://arrayoperator.com/privacy |
| Play listing copy | `store/google-play/listing.md` |
| App Store listing copy | `store/apple/listing.md` |
| Feature graphic 1024×500 | `store/google-play/feature-graphic.png` |
| Screenshots 390×844 | `store/screenshots/01-fleet.png` … `05-agent.png` |
| Icons + splash | `resources/` + generated into android/ios assets |
| App Links fingerprint | `public/.well-known/assetlinks.json` |
| Apple AASA (needs Team ID) | `public/.well-known/apple-app-site-association` — replace `TEAMID` |
| Build script | `scripts/store/build-android-release.sh` |

---

## Android — upload to Google Play

1. Open [Google Play Console](https://play.google.com/console) → Create app  
   - Name: **Array Operator**  
   - Default language: English (US)  
   - Free  
   - Category: **Business**  
2. Fill listing from `store/google-play/listing.md`  
3. Privacy policy URL: **https://arrayoperator.com/privacy**  
4. Upload AAB:  
   - Prefer `store/artifacts/array-operator-release.aab` (signed)  
   - Rebuild:  
     ```bash
     cd /root/array-operator/apps/owner-web
     source android-env.sh
     bash scripts/store/build-android-release.sh
     ```  
5. Content rating questionnaire (utilities / business)  
6. Data safety: account info, app activity, device IDs — not sold; used for app functionality  
7. Target audience: 18+  
8. Release → Internal testing first, then Production  

**Signing:** Upload key is `store/signing/array-operator-release.jks` (alias `arrayoperator`).  
Google Play App Signing will re-sign for distribution — enroll in Play App Signing on first upload.

---

## iOS — upload to App Store (requires Mac + Apple Developer)

Linux cannot produce an `.ipa`. Project is ready for Xcode:

```bash
# On a Mac with Xcode 16+ and CocoaPods/SPM as Capacitor 8 expects:
cd apps/owner-web
npm ci
npm run cap:ios
npx cap open ios
```

In Xcode:

1. Signing & Capabilities → Team = your Apple Developer team  
2. Bundle ID: `com.arrayoperator.app`  
3. Version 1.0.0 / Build 1  
4. Add capability **Associated Domains**: `applinks:arrayoperator.com`  
5. Replace `TEAMID` in `public/.well-known/apple-app-site-association` with your Team ID, redeploy site  
6. Product → Archive → Distribute App → App Store Connect  
7. App Store Connect listing from `store/apple/listing.md`  
8. Privacy policy: https://arrayoperator.com/privacy  
9. Microphone usage string already in Info.plist (Energy Agent voice)

**Apple Developer Program** ($99/yr) required — identity/money gate; agent cannot enroll.

---

## Architecture (one account, all data)

```
[ iOS / Android Capacitor shell ]
        │  WebView loads bundled dist/
        │  API: https://arrayoperator.com/v1/*
        ▼
[ Same backend as web /m ]
  so_session · fleet-tree · offtakers · Energy Agent · Stripe
```

- `VITE_API_BASE=https://arrayoperator.com` in native builds  
- Session key `so_session` identical to desktop/mobile web  
- Magic links: `arrayoperator://auth?token=…` + https App Links  

---

## CORS / deep links

Capacitor WebView origin is typically `https://localhost`. If API calls fail with CORS after install:

```bash
# Append to Railway CORS_ALLOWED_ORIGINS (keep existing list):
# https://localhost,capacitor://localhost,http://localhost
```

Then redeploy backend.

---

## What still needs Ford (cannot fully automate)

1. **Google Play developer account** ($25 one-time) if not already  
2. **Apple Developer Program** enrollment  
3. **First Play upload** + store listing screenshots review  
4. **Xcode archive on Mac** for iOS  
5. **Backup keystore + KEYSTORE.pass** to password manager (loss = cannot update app)  
6. Replace `TEAMID` in apple-app-site-association  
7. Optional: App Store screenshots in required device sizes (6.7", 6.5") — current set is 390×844 @3x good for many slots  

---

## Commands cheat sheet

```bash
cd /root/array-operator/apps/owner-web
source android-env.sh          # JAVA_HOME 21 + ANDROID_HOME
npm run build:native           # web assets for shells
npx cap sync                   # push into android/ + ios/
bash scripts/store/build-android-release.sh   # → store/artifacts/*.aab
```

Web beta (site) still uses:

```bash
npm run build:web   # or publish-to-public.sh → public/m/
```
