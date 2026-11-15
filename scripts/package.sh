#!/usr/bin/env bash
# Builds the upload package for the Chrome Web Store and Microsoft Edge Add-ons:
# dist/unitstager-extension-<version>.zip, containing only the extension itself.
#   bash scripts/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)"
out="dist/unitstager-extension-$version.zip"
mkdir -p dist
rm -f dist/unitstager-extension-*.zip
zip -r -q -X "$out" manifest.json icons src -x '*.DS_Store'
echo "$out ($(du -h "$out" | cut -f1))"
