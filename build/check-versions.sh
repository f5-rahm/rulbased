#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-versions.sh
#
# Validates that all version strings in the codebase match the authoritative
# version in configProcessor.js.  Run on a dev workstation as a pre-commit
# sanity check, or as the last step of a patch script.
#
# Usage:
#   bash build/check-versions.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

AUTH=$(grep "var VERSION" nodejs/lib/configProcessor.js \
  | sed "s/.*'\([^']*\)'.*/\1/")

if [ -z "$AUTH" ]; then
  echo "ERROR: could not extract VERSION from configProcessor.js" >&2
  exit 1
fi

echo "checking version consistency against configProcessor.VERSION = $AUTH"
FAIL=0

check() {
  local file="$1" pattern="$2" label="$3"
  if ! grep -q "$pattern" "$file" 2>/dev/null; then
    printf "  %-50s  MISMATCH\n" "$label"
    FAIL=1
  else
    printf "  %-50s  ✓\n" "$label"
  fi
}

check "presentation/index.html"  "v${AUTH}"                        "presentation/index.html (widget badge)"
check "presentation/app.html"    "db-version-pill\">v${AUTH}<"     "presentation/app.html (header pill)"
check "build/build-rpm.sh"       "VERSION=\"\${1:-${AUTH}}\""      "build/build-rpm.sh (default version)"

echo ""
if [ "$FAIL" -ne 0 ]; then
  echo "version mismatch detected!" >&2
  exit 1
fi
echo "all version strings consistent"
