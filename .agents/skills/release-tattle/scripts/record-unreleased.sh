#!/bin/sh
# Mode C: commit ONLY CHANGELOG.md after adding bullets under [Unreleased]. No bump, no tag.
#   record-unreleased.sh "<short summary>" [attribution line]
set -e
summary="$1"
attribution="$2"
[ -n "$summary" ] || { echo "usage: record-unreleased.sh <summary> [attribution]"; exit 1; }
git add CHANGELOG.md
msg="docs(changelog): record unreleased Tattle change(s) — $summary"
if [ -n "$attribution" ]; then git commit -q -m "$msg" -m "$attribution"; else git commit -q -m "$msg"; fi
echo "ok: recorded in [Unreleased] ($(git rev-parse --short HEAD))"
