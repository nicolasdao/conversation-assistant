#!/bin/sh
# Bump, commit and tag a release. Run from the project root AFTER CHANGELOG.md is stamped.
#   apply-release.sh <version> [attribution line]
# Sets package.json's version (npm keeps package-lock.json in step; skipped when unchanged, as on the
# first release), stages ONLY package.json, package-lock.json and CHANGELOG.md, commits
# "chore(release): conversation-assistant v<version>" and creates the annotated tag v<version>.
set -e
version="$1"
attribution="$2"
[ -n "$version" ] || { echo "usage: apply-release.sh <version> [attribution]"; exit 1; }
current="$(node -p "require('./package.json').version")"
if [ "$current" != "$version" ]; then
  npm version "$version" --no-git-tag-version >/dev/null
fi
if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "tag v$version already exists"; exit 1
fi
git add package.json CHANGELOG.md
[ -f package-lock.json ] && git add package-lock.json
msg="chore(release): conversation-assistant v$version"
if [ -n "$attribution" ]; then
  git commit -q -m "$msg" -m "$attribution"
else
  git commit -q -m "$msg"
fi
git tag -a "v$version" -m "Release v$version"
echo "ok: committed $(git rev-parse --short HEAD) and tagged v$version"
