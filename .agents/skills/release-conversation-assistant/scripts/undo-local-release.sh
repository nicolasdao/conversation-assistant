#!/bin/sh
# Undoes a release that exists only on this Mac (build-app.sh failed, or the user chose not to deploy): deletes the
# local tag v<version> and the release commit, so the same version can be released again after a fix. Refuses once the
# tag is on origin, where it is permanent. Run from the project root.
#   undo-local-release.sh <version>
set -e
version="$1"
[ -n "$version" ] || { echo "usage: undo-local-release.sh <version>"; exit 1; }
if git ls-remote --exit-code --tags origin "v$version" >/dev/null 2>&1; then
  echo "v$version is already on origin: it is final, so fix forward with a new version"; exit 1
fi
[ "$(git log -1 --format=%s)" = "chore(release): conversation-assistant v$version" ] || { echo "HEAD is not the release commit of v$version"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "the working tree is not clean"; exit 1; }
git tag -d "v$version" >/dev/null 2>&1 || true
git reset -q --keep HEAD~1
rm -f "out/.built-v$version"
echo "ok: v$version undone locally; HEAD is back at $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"
