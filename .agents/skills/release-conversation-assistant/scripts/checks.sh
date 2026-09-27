#!/bin/sh
# Release gates: all offline, no API spend. Run from the project root; stops at the first failure.
set -e
echo "== npm run typecheck"; npm run typecheck
echo "== npm test"; npm test
echo "== npm run build:web"; npm run build:web
echo "== npm run build:desktop"; npm run build:desktop
echo "ok: typecheck, tests, web build and Mac app bundle passed"
