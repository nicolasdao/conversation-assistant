#!/bin/sh
# Release gates: all offline, no API spend. Run from the project root; stops at the first failure.
set -e
echo "== npm run typecheck"; npm run typecheck
echo "== npm test"; npm test
echo "== npm run build:web"; npm run build:web
echo "ok: typecheck, tests and web build passed"
