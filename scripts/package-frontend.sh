#!/usr/bin/env bash
# Packages the Provenalt frontend for static hosting (cPanel File Manager → Upload → Extract, or a static host).
#   bash scripts/package-frontend.sh [out.zip]
#   INDEXER_URL=https://<indexer>.up.railway.app bash scripts/package-frontend.sh   (charts, trades, fast lists)
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
# INDEXER_URL=https://... fills config.js's indexerUrl in the package (frontend/config.js itself is untouched).
if [ -n "${INDEXER_URL:-}" ]; then
  case "$INDEXER_URL" in https://*|http://localhost*|http://127.0.0.1*) ;; *) echo "INDEXER_URL must start with https://" >&2; exit 1 ;; esac
  sed -i.bak -E "s#indexerUrl: \"[^\"]*\"#indexerUrl: \"${INDEXER_URL%/}\"#" "$SITE/config.js" && rm -f "$SITE/config.js.bak"
  grep -q "indexerUrl: \"${INDEXER_URL%/}\"" "$SITE/config.js" || { echo "could not set indexerUrl" >&2; exit 1; }
fi
cp frontend/vendor/ethers.umd.min.js "$SITE/vendor/"
sed -E "s#(src|href)=\"(vendor/ethers\.umd\.min\.js|eridanos-sdk\.js|config\.js|app\.js|style\.css)\"#\1=\"\2?v=$VER\"#g" \
  frontend/index.html > "$SITE/index.html"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" provenalt)
echo "wrote $OUT (version $VER)"
unzip -l "$OUT"
