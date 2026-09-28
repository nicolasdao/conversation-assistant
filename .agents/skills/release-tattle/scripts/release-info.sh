#!/bin/sh
# What ships: current version (root package.json, the single source of truth), the last v* tag,
# and the commits and files since it (the whole history when there is no tag yet).
set -e
version="$(node -p "require('./package.json').version")"
last_tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
echo "current_version: $version"
echo "last_tag: ${last_tag:-none}"
if [ -n "$last_tag" ]; then range="$last_tag..HEAD"; else range="HEAD"; fi
echo "range: $range"
echo "commits:"
git log --no-merges --format='  %h %s' $range
echo "files changed:"
if [ -n "$last_tag" ]; then git diff --stat "$last_tag"..HEAD | tail -1; else git ls-files | wc -l | sed 's/^ */  tracked files: /'; fi
if [ -f CHANGELOG.md ]; then
  echo "changelog: present"
  awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md | sed 's/^/  unreleased| /'
else
  echo "changelog: missing (create it)"
fi
