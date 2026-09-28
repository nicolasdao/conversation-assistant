#!/bin/sh
# Builds and verifies the Mac app for a release tagged LOCALLY, before anything is pushed: the locked dependencies,
# their registry signatures, no high-severity advisory in what ships, the third-party notices, then the build, Apple's
# notarization, and the checks Gatekeeper makes. Also fetches the GPL sources and writes the SBOM and checksums. Nothing
# leaves this Mac except the notarization upload to Apple. Run from the project root.
#   build-app.sh <version>
set -e
version="$1"
[ -n "$version" ] || { echo "usage: build-app.sh <version>"; exit 1; }
[ "$(node -p "require('./package.json').version")" = "$version" ] || { echo "package.json is not at $version"; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" >/dev/null || { echo "no local tag v$version: run apply-release.sh first"; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-list -n 1 "v$version")" ] || { echo "HEAD is not v$version"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "the working tree is not clean"; exit 1; }
sh "$(dirname "$0")/credentials.sh" || exit 1
[ -n "${APPLE_API_KEY:-}${APPLE_ID:-}${APPLE_KEYCHAIN_PROFILE:-}" ] || export APPLE_KEYCHAIN_PROFILE=conversation-assistant # the profile keeps its name from before the rename to Tattle

npm ci
npm audit signatures
npm audit --omit=dev --audit-level=high
node scripts/third-party-notices.mjs --check

npm run dist:mac
app="out/mac-arm64/Tattle.app"
dmg="out/Tattle-$version-arm64.dmg"
zip="out/Tattle-$version-arm64-mac.zip"
[ -f "$dmg" ] && [ -f "$zip" ] || { echo "the build did not produce $dmg and $zip"; exit 1; }
grep -q "^version: $version$" out/latest-mac.yml || { echo "out/latest-mac.yml is not for $version"; exit 1; }
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app"

# The GPL-3.0 component inside sherpa-onnx's library (eSpeak NG, see THIRD_PARTY_NOTICES.md) must come with its
# source: the exact sherpa-onnx and eSpeak NG sources it was built from are attached to the release.
sherpa="$(node -p "require('./node_modules/sherpa-onnx-node/package.json').version")"
curl -fsSL -o "out/source-sherpa-onnx-v$sherpa.tar.gz" "https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v$sherpa.tar.gz"
curl -fsSL -o "out/source-espeak-ng-ed530aa113046142eb5115cf2fc9157854d0ffe1.zip" "https://github.com/csukuangfj/espeak-ng/archive/ed530aa113046142eb5115cf2fc9157854d0ffe1.zip"
echo "e4e262cbe34f7fe21f91f1ba3397f2728e1f30eafbae7853f2b753a9ed13f0dd  out/source-espeak-ng-ed530aa113046142eb5115cf2fc9157854d0ffe1.zip" | shasum -a 256 -c -

# what ships inside the app (CycloneDX), and the checksums the release notes will carry
npm sbom --omit=dev --sbom-format=cyclonedx > "out/Tattle-$version-sbom.cdx.json"
(cd out && shasum -a 256 "$(basename "$dmg")" "$(basename "$zip")") > out/SHA256SUMS
git rev-parse HEAD > "out/.built-v$version" # deploy.sh publishes only a build of exactly this commit
echo "ok: built and verified v$version ($(git rev-parse --short HEAD)); nothing has been pushed or published"
