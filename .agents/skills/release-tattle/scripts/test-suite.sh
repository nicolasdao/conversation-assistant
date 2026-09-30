#!/bin/sh
# Step 1 of a release: the whole test suite (docs/testing.md). Unit tests with the coverage thresholds, the capture
# helper's Swift tests, and the end-to-end tests of the web page and of the Mac app (development build, offline, no
# keys, an isolated HOME). No API spend and no network: every service is faked. Run from the project root; stops at
# the first failure, and first checks what the suite needs, saying how to get it.
set -e
for f in models/silero_vad.onnx models/wespeaker_en_voxceleb_resnet34_LM.onnx fixtures/conversation/host.wav fixtures/conversation/remote.wav fixtures/conversation/script.json; do
  if [ ! -f "$f" ]; then
    echo "error: $f is missing: run  npm run models && npm run fixtures" >&2
    exit 1
  fi
done
if ! node -e 'const { chromium } = require("@playwright/test"); process.exit(require("fs").existsSync(chromium.executablePath()) ? 0 : 1)' 2>/dev/null; then
  echo "error: Playwright's Chromium is not installed: run  npx playwright install chromium" >&2
  exit 1
fi
if ! command -v swift >/dev/null 2>&1; then
  echo "error: swift is not available: install Xcode or its command line tools (xcode-select --install)" >&2
  exit 1
fi
echo "== npm run test:all (typecheck, unit + coverage, Swift, end-to-end)"
npm run test:all
echo "ok: test suite passed (unit + coverage, Swift, end-to-end)"
