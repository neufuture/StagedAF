#!/usr/bin/env bash
# Bundles everything needed for a store submission into one zip:
# the extension package, screenshots, promo tile, icons and listing text.
#   bash scripts/store-kit.sh
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/package.sh >/dev/null
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)"
kit="dist/unitstager-store-kit-$version.zip"
tmp="$(mktemp -d)"
mkdir -p "$tmp/unitstager-store-kit/screenshots" "$tmp/unitstager-store-kit/logo"
cp "dist/unitstager-extension-$version.zip" "$tmp/unitstager-store-kit/1-upload-this-unitstager-extension-$version.zip"
cp store/screenshot-*.png "$tmp/unitstager-store-kit/screenshots/"
cp store/promo-tile-440x280.png "$tmp/unitstager-store-kit/"
cp icons/icon128.png "$tmp/unitstager-store-kit/logo/store-icon-128.png"
cp brand/unitstager-icon-512.png brand/unitstager-icon-circle-512.png brand/unitstager-icon.svg brand/unitstager-icon-circle.svg "$tmp/unitstager-store-kit/logo/"
cp docs/STORE_LISTING.md "$tmp/unitstager-store-kit/listing-text.md"
rm -f dist/unitstager-store-kit-*.zip
(cd "$tmp" && zip -r -q -X kit.zip unitstager-store-kit)
mv "$tmp/kit.zip" "$kit"
rm -rf "$tmp"
echo "$kit ($(du -h "$kit" | cut -f1))"
