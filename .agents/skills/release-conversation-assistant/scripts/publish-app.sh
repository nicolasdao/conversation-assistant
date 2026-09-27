#!/bin/sh
# Publishes the Mac app for a release already tagged and pushed: builds it from the tag, checks its signature and
# notarization, and creates the GitHub Release v<version> with the DMG (what people download) and the files the
# installed app reads to update itself (see docs/desktop.md). Run only after the user confirms.
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
[ -n "$APPLE_API_KEY$APPLE_ID" ] \
  || { echo "no notary credentials (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID): Gatekeeper blocks an app that is not notarized"; exit 1; }

npm run dist:mac
app="out/mac-arm64/Conversation Assistant.app"
dmg="out/Conversation-Assistant-$version-arm64.dmg"
zip="out/Conversation-Assistant-$version-arm64-mac.zip"
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app"

gh release create "v$version" --verify-tag --title "Conversation Assistant $version" --notes-file "$notes" \
  "$dmg" "$dmg.blockmap" "$zip" "$zip.blockmap" out/latest-mac.yml
echo "ok: published v$version with $(basename "$dmg")"
