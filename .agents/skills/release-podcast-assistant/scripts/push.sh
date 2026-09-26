#!/bin/sh
# Push the release commit and its tag to origin. Run only after the user confirms.
#   push.sh <version>
set -e
version="$1"
[ -n "$version" ] || { echo "usage: push.sh <version>"; exit 1; }
branch="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$branch"
git push origin "v$version"
echo "ok: pushed $branch and v$version to origin"
