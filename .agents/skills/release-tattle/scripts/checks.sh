#!/bin/sh
# Release gates: no API spend, and offline except that right after a clean install the notices check downloads
# Electron's binary once. Run from the project root; stops at the first failure.
set -e
echo "== npm run typecheck"; npm run typecheck
echo "== npm test"; npm test
echo "== npm run build:web"; npm run build:web
echo "== npm run build:desktop"; npm run build:desktop
echo "== third-party notices"; node scripts/third-party-notices.mjs --check
echo "ok: typecheck, tests, web build, Mac app bundle and third-party notices passed"
