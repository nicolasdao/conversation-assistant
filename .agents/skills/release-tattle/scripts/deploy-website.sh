#!/bin/sh
# Publishes the website update that update-website.sh wrote: commits website/index.html alone, pushes master, and waits
# until https://hey-tattle.com serves the new DMG link. Cloudflare redeploys the site by itself on any push to master that
# changes website/ (docs/website.md), usually within 3 minutes. Run from the project root, after update-website.sh.
#   deploy-website.sh <version> [attribution]
set -e
version="$1"
attribution="$2"
site="https://hey-tattle.com/"
[ -n "$version" ] || { echo "usage: deploy-website.sh <version> [attribution]"; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "master" ] || { echo "not on master"; exit 1; }
[ -z "$(git status --porcelain | grep -v ' website/index.html$')" ] || { echo "the working tree has changes besides website/index.html"; exit 1; }
grep -q "Tattle-$version-arm64.dmg" website/index.html || { echo "website/index.html does not link v$version: run update-website.sh $version first"; exit 1; }

if [ -n "$(git status --porcelain website/index.html)" ]; then
  msg="chore(website): point the download and release line at v$version"
  [ -n "$attribution" ] && msg="$(printf '%s\n\n%s' "$msg" "$attribution")"
  git add website/index.html
  git commit -q -m "$msg"
  echo "ok: committed $(git log --oneline -1)"
fi
git push -q origin master
echo "ok: pushed master; waiting for Cloudflare to deploy $site"

i=0
until curl -fsSL "$site" 2>/dev/null | grep -q "Tattle-$version-arm64.dmg"; do
  i=$((i + 1))
  [ "$i" -le 40 ] || { echo "after 10 minutes $site does not link v$version yet: check the build under Workers & Pages → tattle-website → Deployments"; exit 1; }
  sleep 15
done
echo "ok: $site links Tattle-$version-arm64.dmg"
