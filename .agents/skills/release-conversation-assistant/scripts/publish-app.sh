#!/bin/sh
# Publishes the Mac app for a release already tagged and pushed: builds it from the tag, checks its signature and
# notarization, and creates the GitHub Release v<version> with the DMG (what people download) and the files the
# installed app reads to update itself (see docs/desktop.md), with SHA-256 checksums in the notes and an SBOM. It
# installs the locked dependencies first and refuses to publish if a registry signature fails or a high-severity
# vulnerability is known in what ships. Run only after the user confirms.
#   publish-app.sh <version> <notes-file>
set -e
version="$1"
notes="$2"
[ -n "$version" ] && [ -f "$notes" ] || { echo "usage: publish-app.sh <version> <notes-file>"; exit 1; }
[ "$(node -p "require('./package.json').version")" = "$version" ] || { echo "package.json is not at $version"; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" >/dev/null || { echo "no tag v$version: release first"; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-list -n 1 "v$version")" ] || { echo "HEAD is not v$version: check out the tag first"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "the working tree is not clean"; exit 1; }
git ls-remote --exit-code --tags origin "v$version" >/dev/null || { echo "v$version is not on origin: push it first"; exit 1; }
command -v gh >/dev/null || { echo "the GitHub CLI (gh) is required: brew install gh"; exit 1; }
security find-identity -v -p codesigning | grep -q "Developer ID Application" \
  || { echo "no Developer ID Application certificate in the keychain: an ad-hoc build must never be published"; exit 1; }
if [ -z "$APPLE_API_KEY$APPLE_ID$APPLE_KEYCHAIN_PROFILE" ] \
  && xcrun notarytool history --keychain-profile conversation-assistant >/dev/null 2>&1; then
  export APPLE_KEYCHAIN_PROFILE=conversation-assistant
fi
[ -n "$APPLE_API_KEY$APPLE_ID$APPLE_KEYCHAIN_PROFILE" ] \
  || { echo "no notary credentials (the keychain profile conversation-assistant, APPLE_KEYCHAIN_PROFILE, APPLE_API_KEY…, or APPLE_ID…): Gatekeeper blocks an app that is not notarized"; exit 1; }

# the dependencies exactly as locked, with registry signatures verified, and nothing known to be vulnerable in what ships
npm ci
npm audit signatures
npm audit --omit=dev --audit-level=high
node scripts/third-party-notices.mjs --check

npm run dist:mac
app="out/mac-arm64/Conversation Assistant.app"
dmg="out/Conversation-Assistant-$version-arm64.dmg"
zip="out/Conversation-Assistant-$version-arm64-mac.zip"
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app"

# The GPL-3.0 component inside sherpa-onnx's library (eSpeak NG, see THIRD_PARTY_NOTICES.md) must come with its
# source: the exact sherpa-onnx and eSpeak NG sources it was built from are attached to the release.
sherpa="$(node -p "require('./node_modules/sherpa-onnx-node/package.json').version")"
src_sherpa="out/source-sherpa-onnx-v$sherpa.tar.gz"
src_espeak="out/source-espeak-ng-ed530aa113046142eb5115cf2fc9157854d0ffe1.zip"
curl -fsSL -o "$src_sherpa" "https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v$sherpa.tar.gz"
curl -fsSL -o "$src_espeak" "https://github.com/csukuangfj/espeak-ng/archive/ed530aa113046142eb5115cf2fc9157854d0ffe1.zip"
echo "e4e262cbe34f7fe21f91f1ba3397f2728e1f30eafbae7853f2b753a9ed13f0dd  $src_espeak" | shasum -a 256 -c -

# what ships inside the app (CycloneDX), and checksums anyone can verify a download against
sbom="out/Conversation-Assistant-$version-sbom.cdx.json"
npm sbom --omit=dev --sbom-format=cyclonedx > "$sbom"
full="$(mktemp)"
{ cat "$notes"; printf '\n**SHA-256**\n\n```\n'; (cd out && shasum -a 256 "$(basename "$dmg")" "$(basename "$zip")"); printf '```\n\nThe app is signed by "Developer ID Application: Nicolas Dao (UX774V7BK2)" and notarized by Apple. Download it only from this page.\n'; } > "$full"

gh release create "v$version" --verify-tag --title "Conversation Assistant $version" --notes-file "$full" \
  "$dmg" "$dmg.blockmap" "$zip" "$zip.blockmap" out/latest-mac.yml "$sbom" "$src_sherpa" "$src_espeak"
rm -f "$full"
echo "ok: published v$version with $(basename "$dmg")"
