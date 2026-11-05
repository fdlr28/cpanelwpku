#!/usr/bin/env bash
# Packages the Hypelys frontend for static hosting (cPanel File Manager → Upload → Extract).
#   bash scripts/package-frontend.sh [out.zip]
# Contains only what the site needs (no config.local.js, no legacy MVP). Script/style URLs in index.html get
# ?v=<git commit> so browsers fetch the new files after an update instead of a cached copy.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-dist/hypelys-frontend.zip}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
VER="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
if [ -n "$(git status --porcelain frontend 2>/dev/null)" ]; then VER="$VER-dirty"; fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/vendor" "$(dirname "$OUT")"
cp frontend/app.js frontend/style.css frontend/config.js frontend/eridanos-sdk.js "$STAGE/"
cp frontend/vendor/ethers.umd.min.js "$STAGE/vendor/"
sed -E "s#(src|href)=\"(vendor/ethers\.umd\.min\.js|eridanos-sdk\.js|config\.js|app\.js|style\.css)\"#\1=\"\2?v=$VER\"#g" \
  frontend/index.html > "$STAGE/index.html"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" index.html app.js style.css config.js eridanos-sdk.js vendor)
echo "wrote $OUT (version $VER)"
unzip -l "$OUT"
