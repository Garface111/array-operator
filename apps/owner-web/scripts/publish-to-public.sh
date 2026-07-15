#!/usr/bin/env bash
# Build owner-web and publish into public/m/ for arrayoperator.com mobile beta.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/apps/owner-web"
DEST="$ROOT/public/m"

cd "$APP"
npm run build
rm -rf "$DEST"
mkdir -p "$DEST"
# Copy production assets (skip source maps to keep Netlify deploy smaller)
rsync -a --exclude='*.map' "$APP/dist/" "$DEST/"
echo "Published $(find "$DEST" -type f | wc -l) files → public/m/"
ls -la "$DEST"
