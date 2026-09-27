#!/bin/sh
# Builds the Mac app into out/: Conversation-Assistant-<version>-arm64.dmg, the zip auto-update downloads, and
# latest-mac.yml (see docs/desktop.md). npm run dist:mac
#
# With a "Developer ID Application" certificate in the keychain, the app is signed with it, and notarized when the
# notary credentials are set (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, or APPLE_ID,
# APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID). Without one, it is signed ad hoc: it runs on this Mac only.
set -e
cd "$(dirname "$0")/.."

[ -f models/silero_vad.onnx ] && [ -f models/wespeaker_en_voxceleb_resnet34_LM.onnx ] || npm run models
npm run build:capture
npm run build:web
npm run build:desktop
rm -rf out

if security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  if [ -n "$APPLE_API_KEY$APPLE_ID" ]; then
    npx electron-builder --mac --publish never "$@"
  else
    echo "Signing with the Developer ID, but NOT notarizing: no notary credentials are set (see docs/desktop.md)."
    npx electron-builder --mac --publish never -c.mac.notarize=false "$@"
  fi
else
  echo "No Developer ID Application certificate in the keychain: signing ad hoc. This build runs on this Mac only."
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never -c.mac.identity=- -c.mac.notarize=false \
    -c.mac.entitlements=desktop/entitlements.adhoc.plist -c.mac.entitlementsInherit=desktop/entitlements.adhoc.plist "$@"
fi
ls -lh out/*.dmg out/*.zip out/latest-mac.yml
