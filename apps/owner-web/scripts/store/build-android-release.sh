#!/usr/bin/env bash
# Build a signed/unsigned Play Store AAB for Array Operator (Capacitor Android).
#
# Prerequisites:
#   - source android-env.sh (or this script sources it)
#   - Capacitor android/ project present (parent agent adds Capacitor)
#   - Optional: store/signing keystore via create-keystore.sh + gradle signing config
#
# Usage (from apps/owner-web):
#   ./scripts/store/build-android-release.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/android-env.sh"

if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "$ANDROID_HOME" ]; then
  echo "ERROR: ANDROID_HOME not set or missing: ${ANDROID_HOME:-}" >&2
  exit 1
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/java" ]; then
  echo "ERROR: JAVA_HOME not set or java missing: ${JAVA_HOME:-}" >&2
  exit 1
fi

echo "==> ANDROID_HOME=$ANDROID_HOME"
echo "==> JAVA_HOME=$JAVA_HOME"
java -version 2>&1 | head -1

# --- Web build (Capacitor loads dist/ from file:// so base must be relative) ---
export VITE_BASE="${VITE_BASE:-./}"
export VITE_API_BASE="${VITE_API_BASE:-https://arrayoperator.com}"

echo "==> Building web (VITE_BASE=$VITE_BASE VITE_API_BASE=$VITE_API_BASE)"
if npm run | grep -qE '^\s*build:native'; then
  npm run build:native
else
  # Fallback until package.json gains build:native
  echo "    (no build:native script; using npm run build with native env)"
  npm run build
fi

if [ ! -d "$ROOT/android" ]; then
  echo "ERROR: android/ project not found. Add Capacitor first:" >&2
  echo "  npm i @capacitor/core @capacitor/cli @capacitor/android" >&2
  echo "  npx cap init 'Array Operator' com.arrayoperator.app --web-dir dist" >&2
  echo "  npx cap add android" >&2
  exit 1
fi

echo "==> npx cap sync android"
npx cap sync android

echo "==> Gradle bundleRelease"
(
  cd "$ROOT/android"
  if [ -x ./gradlew ]; then
    ./gradlew bundleRelease
  else
    echo "ERROR: android/gradlew missing" >&2
    exit 1
  fi
)

# Locate AAB (AGP path varies slightly by module name)
AAB_SRC=""
for candidate in \
  "$ROOT/android/app/build/outputs/bundle/release/app-release.aab" \
  "$ROOT/android/app/build/outputs/bundle/release/"*.aab
do
  if [ -f "$candidate" ]; then
    AAB_SRC="$candidate"
    break
  fi
done

if [ -z "$AAB_SRC" ]; then
  echo "ERROR: No AAB found under android/app/build/outputs/bundle/release/" >&2
  find "$ROOT/android/app/build/outputs" -name '*.aab' 2>/dev/null || true
  exit 1
fi

mkdir -p "$ROOT/store/artifacts"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
AAB_DEST="$ROOT/store/artifacts/array-operator-${STAMP}.aab"
cp -f "$AAB_SRC" "$AAB_DEST"
# Also keep a stable latest name for CI/scripts
cp -f "$AAB_SRC" "$ROOT/store/artifacts/array-operator-release.aab"

echo "==> AAB copied:"
echo "    $AAB_DEST"
echo "    $ROOT/store/artifacts/array-operator-release.aab"
ls -lh "$AAB_DEST"
echo "Done."
