#!/bin/sh
# Clean-tree gate. Run from the project root.
#   preflight.sh release   Mode A/B: any uncommitted change aborts (hard gate, no "proceed anyway").
#   preflight.sh ledger    Mode C: only CHANGELOG.md must be free of unstaged edits.
set -e
mode="${1:-release}"
if [ "$mode" = "ledger" ]; then
  if git status --porcelain -- CHANGELOG.md | grep -q '^.M'; then
    echo "CHANGELOG.md has unstaged edits. Commit or stash them before recording to [Unreleased]."
    exit 1
  fi
  echo "ok: ledger pre-flight passed"
  exit 0
fi
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then
  echo "Cannot release - uncommitted changes:"
  echo
  echo "$dirty"
  echo
  echo "The release only commits package.json, package-lock.json and CHANGELOG.md."
  echo "It does NOT commit your feature/fix code, so running it now would produce"
  echo "a tag that doesn't contain the changes it ships."
  echo
  echo "Commit your changes first, then re-run the release."
  exit 1
fi
echo "ok: working tree clean"
