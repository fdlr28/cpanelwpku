#!/usr/bin/env bash
# Packages the Provenalt frontend for static hosting (cPanel File Manager → Upload → Extract, or a static host).
#   bash scripts/package-frontend.sh [out.zip]
# The zip holds one folder, provenalt/, with index.html at its top: extract it where the domain's document root
# should be (e.g. cPanel home → /home/<user>/provenalt, then point the domain's document root there).
# Contains only what the site needs (no config.local.js, no legacy MVP). Script/style URLs in index.html get
# ?v=<git commit> so browsers fetch the new files after an update instead of a cached copy.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-dist/provenalt-frontend.zip}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
VER="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
if [ -n "$(git status --porcelain frontend 2>/dev/null)" ]; then VER="$VER-dirty"; fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
SITE="$STAGE/provenalt"
mkdir -p "$SITE/vendor" "$(dirname "$OUT")"
cp frontend/app.js frontend/style.css frontend/config.js frontend/eridanos-sdk.js "$SITE/"
cp frontend/vendor/ethers.umd.min.js "$SITE/vendor/"
sed -E "s#(src|href)=\"(vendor/ethers\.umd\.min\.js|eridanos-sdk\.js|config\.js|app\.js|style\.css)\"#\1=\"\2?v=$VER\"#g" \
  frontend/index.html > "$SITE/index.html"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" provenalt)
echo "wrote $OUT (version $VER)"
unzip -l "$OUT"
