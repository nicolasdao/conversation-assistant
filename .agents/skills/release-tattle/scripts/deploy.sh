#!/bin/sh
# Deploys a release to production: pushes master and the tag v<version>, then publishes the GitHub Release every
# installed copy updates to, from the build build-app.sh verified for exactly this commit. Irreversible: a pushed tag
# and a published release are final (see docs/desktop.md). Run only after the user confirms, from the project root.
#   deploy.sh <version> <notes-file>
set -e
version="$1"
notes="$2"
[ -n "$version" ] && [ -f "$notes" ] || { echo "usage: deploy.sh <version> <notes-file>"; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-list -n 1 "v$version" 2>/dev/null)" ] || { echo "HEAD is not v$version"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "the working tree is not clean"; exit 1; }
[ "$(cat "out/.built-v$version" 2>/dev/null)" = "$(git rev-parse HEAD)" ] || { echo "no verified build of this commit: run build-app.sh $version first"; exit 1; }
if gh release view "v$version" >/dev/null 2>&1; then echo "v$version is already published"; exit 1; fi
dmg="out/Tattle-$version-arm64.dmg"
zip="out/Tattle-$version-arm64-mac.zip"
(cd out && shasum -a 256 -c SHA256SUMS) || { echo "the built files changed since build-app.sh verified them"; exit 1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$branch"
git ls-remote --exit-code --tags origin "v$version" >/dev/null 2>&1 || git push origin "v$version"

full="$(mktemp)"
{ cat "$notes"; printf '\n**SHA-256**\n\n```\n'; cat out/SHA256SUMS; printf '```\n\nThe app is signed by "Developer ID Application: Nicolas Dao (UX774V7BK2)" and notarized by Apple. Download it only from this page.\n'; } > "$full"
gh release create "v$version" --verify-tag --title "Tattle $version" --notes-file "$full" \
  "$dmg" "$dmg.blockmap" "$zip" "$zip.blockmap" out/latest-mac.yml "out/Tattle-$version-sbom.cdx.json" \
  out/source-sherpa-onnx-v*.tar.gz out/source-espeak-ng-*.zip
rm -f "$full"
echo "ok: deployed v$version: $(gh release view "v$version" --json url --jq .url)"
