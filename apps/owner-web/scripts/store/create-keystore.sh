#!/usr/bin/env bash
# Create the Android release keystore for Array Operator Play uploads.
#
# - Generates store/signing/array-operator-release.jks ONLY if missing
# - Writes passwords to store/signing/KEYSTORE.pass (chmod 600)
# - NEVER commit *.jks / *.pass / *.keystore (see store/signing/.gitignore)
#
# Usage (from apps/owner-web):
#   ./scripts/store/create-keystore.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIGNING_DIR="$ROOT/store/signing"
KEYSTORE="$SIGNING_DIR/array-operator-release.jks"
PASSFILE="$SIGNING_DIR/KEYSTORE.pass"
ALIAS="${KEYSTORE_ALIAS:-arrayoperator}"
VALIDITY_DAYS="${KEYSTORE_VALIDITY_DAYS:-10000}"

# shellcheck disable=SC1091
if [ -f "$ROOT/android-env.sh" ]; then
  source "$ROOT/android-env.sh"
fi

mkdir -p "$SIGNING_DIR"

if [ -f "$KEYSTORE" ]; then
  echo "Keystore already exists: $KEYSTORE"
  echo "Leaving it untouched (re-running must not rotate production keys)."
  if [ ! -f "$PASSFILE" ]; then
    echo "WARNING: $PASSFILE missing but keystore present — recover passwords offline." >&2
  fi
  exit 0
fi

if ! command -v keytool >/dev/null 2>&1; then
  echo "ERROR: keytool not found. Install OpenJDK 17 (openjdk-17-jdk-headless)." >&2
  exit 1
fi

# Random passwords (alnum only for gradle.properties friendliness)
gen_pass() {
  # 32 bytes hex → 32 chars
  openssl rand -hex 16
}

STORE_PASS="${KEYSTORE_STORE_PASS:-$(gen_pass)}"
KEY_PASS="${KEYSTORE_KEY_PASS:-$STORE_PASS}"

echo "==> Generating release keystore"
echo "    path:    $KEYSTORE"
echo "    alias:   $ALIAS"
echo "    validity: ${VALIDITY_DAYS} days"

keytool -genkeypair \
  -v \
  -storetype JKS \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 2048 \
  -validity "$VALIDITY_DAYS" \
  -storepass "$STORE_PASS" \
  -keypass "$KEY_PASS" \
  -dname "CN=Array Operator, OU=Mobile, O=Array Operator, L=Unknown, ST=Unknown, C=US"

chmod 600 "$KEYSTORE"

# Password file — NEVER commit
{
  echo "# Array Operator Android release keystore credentials"
  echo "# NEVER commit this file. chmod 600. Back up offline (password manager)."
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "KEYSTORE_PATH=$KEYSTORE"
  echo "KEYSTORE_ALIAS=$ALIAS"
  echo "KEYSTORE_STORE_PASS=$STORE_PASS"
  echo "KEYSTORE_KEY_PASS=$KEY_PASS"
} >"$PASSFILE"
chmod 600 "$PASSFILE"

echo "==> Wrote $PASSFILE (mode 600)"
echo ""
echo "IMPORTANT:"
echo "  - Do NOT commit $KEYSTORE or $PASSFILE"
echo "  - Back up both offline before any Play Console upload"
echo "  - Losing this keystore permanently blocks app updates on the same listing"
echo "Done."
