# Array Operator — Android release build

Phone-first Capacitor shell around `apps/owner-web` for Google Play.

| Item | Value |
|------|--------|
| App ID | `com.arrayoperator.app` |
| Display name | Array Operator |
| Web dir | `dist/` (Vite) |
| Min practical API | set by Capacitor / AGP (target SDK 34 tooling installed) |
| Artifact | AAB → `store/artifacts/` |

## Machine setup (WSL / Linux)

### 1. Java 17

```bash
sudo apt-get install -y openjdk-17-jdk-headless
```

### 2. Android SDK (already provisioned on this host)

- **ANDROID_HOME**: `/opt/android-sdk`
- Installed packages:
  - `cmdline-tools` (latest under `cmdline-tools/latest`)
  - `platform-tools`
  - `platforms;android-34`
  - `build-tools;34.0.0`
- Licenses: accepted via `sdkmanager --licenses`

Load env (from `apps/owner-web`):

```bash
source ./android-env.sh
# exports ANDROID_HOME, ANDROID_SDK_ROOT, JAVA_HOME, PATH
sdkmanager --version   # expect 12.x+
adb version
```

Re-install packages if needed:

```bash
source ./android-env.sh
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

### 3. Capacitor (parent agent)

Capacitor is **not** assumed present until the parent wires it. Typical once:

```bash
cd apps/owner-web
source ./android-env.sh
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Array Operator" com.arrayoperator.app --web-dir dist
npx cap add android
```

Ensure `capacitor.config` uses `appId: com.arrayoperator.app` and `webDir: dist`.

Add a convenient script if missing:

```json
"build:native": "tsc --noEmit && vite build"
```

Native builds **must** use relative base so assets load under Capacitor:

```bash
VITE_BASE=./ VITE_API_BASE=https://arrayoperator.com npm run build:native
```

(`vite.config.ts` already honors `VITE_BASE`.)

## Signing

### Create keystore (once)

```bash
./scripts/store/create-keystore.sh
```

Produces (gitignored):

| File | Purpose |
|------|---------|
| `store/signing/array-operator-release.jks` | Release keystore (alias `arrayoperator`, 10000-day validity) |
| `store/signing/KEYSTORE.pass` | Store/key passwords (`chmod 600`) |

**NEVER commit** `*.jks`, `*.pass`, or `*.keystore`. See `store/signing/.gitignore`.

Back up the `.jks` + `KEYSTORE.pass` offline (password manager / encrypted vault). Losing them blocks updates on the same Play listing.

### Wire Gradle signing

After Capacitor creates `android/`, configure release signing (example — do not commit real passwords):

`android/keystore.properties` (gitignored, generated from `KEYSTORE.pass`):

```properties
storeFile=../store/signing/array-operator-release.jks
storePassword=...
keyAlias=arrayoperator
keyPassword=...
```

Or inject from env when running Gradle. Point `android/app/build.gradle` `signingConfigs.release` at that file.

Without signing config, `bundleRelease` may still produce an **unsigned** or **debug-signed** AAB depending on AGP defaults — Play Console requires a proper upload key / app signing key.

## One-shot release build

```bash
cd apps/owner-web
source ./android-env.sh
./scripts/store/create-keystore.sh          # no-op if exists
./scripts/store/build-android-release.sh
```

`build-android-release.sh` does:

1. `source android-env.sh`
2. Web build: `VITE_BASE=./` + `VITE_API_BASE=https://arrayoperator.com` via `npm run build:native` (falls back to `npm run build`)
3. `npx cap sync android`
4. `./gradlew bundleRelease` in `android/`
5. Copy AAB → `store/artifacts/array-operator-<UTC>.aab` and `store/artifacts/array-operator-release.aab`

## Play Console upload

1. Create app **Array Operator** with package `com.arrayoperator.app` (must match forever).
2. Enroll in Play App Signing (Google holds the app signing key; you keep the upload keystore above).
3. Upload `store/artifacts/array-operator-release.aab` to Internal testing first.
4. Complete Data safety, content rating, store listing, privacy policy.

## Scripts

| Path | Role |
|------|------|
| `android-env.sh` | `ANDROID_HOME`, `JAVA_HOME`, `PATH` |
| `scripts/store/create-keystore.sh` | One-time keystore + `KEYSTORE.pass` |
| `scripts/store/build-android-release.sh` | Web → cap sync → AAB → artifacts |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `sdkmanager` / Gradle: no Java | `source android-env.sh`; install `openjdk-17-jdk-headless` |
| `ANDROID_HOME` missing | Export `/opt/android-sdk` or re-source `android-env.sh` |
| `android/` missing | Parent must add Capacitor (`npx cap add android`) |
| Blank WebView / broken assets | Rebuild with `VITE_BASE=./` |
| API calls fail offline | Confirm `VITE_API_BASE=https://arrayoperator.com` and cleartext/HTTPS settings |
| License prompts | `yes \| sdkmanager --licenses` |

## Host inventory (this environment)

| Check | Result |
|-------|--------|
| ANDROID_HOME | `/opt/android-sdk` |
| sdkmanager | Works (v12.0) |
| platform-tools | Installed |
| platforms;android-34 | Installed |
| build-tools;34.0.0 | Installed |
| JAVA_HOME | `/usr/lib/jvm/java-17-openjdk-amd64` |
