#!/bin/sh
# Can this Mac deploy? Checks, without building or sending anything: the Developer ID certificate (and how long it has
# left), the notary credentials, and GitHub access to origin. Run from the project root. Exit 1 when it cannot deploy.
#   credentials.sh
set -u
fail=0
cert="$(security find-certificate -c "Developer ID Application" -p 2>/dev/null)"
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application" || [ -z "$cert" ]; then
  echo "missing: a Developer ID Application certificate (with its private key) in the keychain"; fail=1
else
  name="$(security find-identity -v -p codesigning | grep -o '"Developer ID Application[^"]*"' | head -1)"
  end="$(printf '%s\n' "$cert" | openssl x509 -noout -enddate | cut -d= -f2)"
  days=$(( ( $(date -j -f "%b %e %T %Y %Z" "$end" +%s) - $(date +%s) ) / 86400 ))
  if [ "$days" -lt 0 ]; then echo "expired: $name (on $end): create a new one in Xcode"; fail=1
  elif [ "$days" -lt 30 ]; then echo "warning: $name expires in $days days ($end): create a new one in Xcode soon"
  else echo "ok: $name, valid for $days more days"; fi
  # Apple's first Developer ID intermediate expires on 1 Feb 2027 and caps every certificate it issued; the G2 one
  # issues certificates for 5 years. Both are named "Developer ID Certification Authority": only the G2 one has
  # OU=G2, so the whole issuer is checked, not its CN.
  issuer="$(printf '%s\n' "$cert" | openssl x509 -noout -issuer)"
  case "$issuer" in
    *G2*) echo "ok: issued by the G2 Developer ID authority (certificates for up to 5 years)";;
    *) echo "note: issued by the older \"Developer ID Certification Authority\", so it cannot outlive 1 Feb 2027: create a new Developer ID Application certificate on developer.apple.com, choosing the G2 Sub-CA (5 years), then remove this one from the keychain (do not revoke it)";;
  esac
fi
if [ -n "${APPLE_API_KEY:-}${APPLE_ID:-}${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  echo "ok: notary credentials from the environment"
elif xcrun notarytool history --keychain-profile conversation-assistant >/dev/null 2>&1; then
  echo "ok: notary credentials (keychain profile conversation-assistant, accepted by Apple)"
else
  echo "missing: notary credentials (xcrun notarytool store-credentials conversation-assistant; see docs/desktop.md § Signing)"; fail=1
fi
repo="$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')"
if ! command -v gh >/dev/null; then echo "missing: the GitHub CLI (brew install gh)"; fail=1
elif [ "$(gh api "repos/$repo" --jq .permissions.push 2>/dev/null)" != "true" ]; then echo "missing: push access to $repo (gh auth login)"; fail=1
else echo "ok: GitHub access to $repo"; fi
[ "$fail" = 0 ] && echo "ok: this Mac can deploy" || echo "cannot deploy: fix the above first"
exit "$fail"
