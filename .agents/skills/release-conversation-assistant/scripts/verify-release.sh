#!/bin/sh
# Checks production from the outside, as a stranger and an installed app see it, without logging in: the update feed
# names <version>, the published DMG matches its checksum, and a downloaded copy, flagged as from the internet, passes
# Gatekeeper as notarized with Apple's ticket stapled. Run from the project root after deploy.sh.
#   verify-release.sh <version>
set -e
version="$1"
[ -n "$version" ] || { echo "usage: verify-release.sh <version>"; exit 1; }
repo="$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')"
tmp="$(mktemp -d)"
trap 'hdiutil detach "$tmp/mnt" -quiet 2>/dev/null; rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/latest-mac.yml" "https://github.com/$repo/releases/latest/download/latest-mac.yml"
grep -q "^version: $version$" "$tmp/latest-mac.yml" || { echo "the update feed does not name $version:"; grep '^version' "$tmp/latest-mac.yml"; exit 1; }
echo "ok: installed apps are offered $version"
dmg="Conversation-Assistant-$version-arm64.dmg"
curl -fsSL -o "$tmp/$dmg" "https://github.com/$repo/releases/download/v$version/$dmg"
want="$(awk -v d="$dmg" '$0 ~ "url: "d {f=1} f && /sha512:/ {print $2; exit}' "$tmp/latest-mac.yml")"
[ "$(openssl dgst -sha512 -binary "$tmp/$dmg" | base64)" = "$want" ] || { echo "the downloaded DMG does not match the update feed"; exit 1; }
if [ -f out/SHA256SUMS ]; then (cd "$tmp" && grep " $dmg$" "$OLDPWD/out/SHA256SUMS" | shasum -a 256 -c -) >/dev/null || { echo "the downloaded DMG does not match the build"; exit 1; }; fi
echo "ok: the published DMG is the one that was built"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" "$tmp/$dmg"
mkdir "$tmp/mnt" && hdiutil attach -nobrowse -readonly -mountpoint "$tmp/mnt" "$tmp/$dmg" >/dev/null
cp -R "$tmp/mnt/Conversation Assistant.app" "$tmp/"
spctl --assess --type execute -vv "$tmp/Conversation Assistant.app" 2>&1 | grep -q "source=Notarized Developer ID" || { echo "Gatekeeper does not accept the downloaded app"; exit 1; }
xcrun stapler validate "$tmp/Conversation Assistant.app" >/dev/null
echo "ok: a downloaded copy passes Gatekeeper as notarized, with Apple's ticket stapled"
echo "ok: v$version is live and verified"
