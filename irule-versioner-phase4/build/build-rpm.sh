#!/usr/bin/env bash
# =============================================================================
# build-rpm.sh
#
# Builds the irule-versioner iApps LX RPM locally using rpmbuild.
# No BIG-IP connection or credentials required.
#
# Prerequisites:
#   Linux/macOS with rpmbuild available
#     RHEL/CentOS:  sudo yum install rpm-build
#     Ubuntu:       sudo apt install rpm
#     macOS:        brew install rpm
#
#   Or run inside a container:
#     docker run --rm -v $(pwd):/src centos:7 bash /src/build/build-rpm.sh
#
# Usage:
#   ./build/build-rpm.sh [VERSION] [RELEASE]
#
# Examples:
#   ./build/build-rpm.sh              # uses defaults: 1.0.0-0001
#   ./build/build-rpm.sh 1.2.0 0003
#
# Output:
#   build/dist/irule-versioner-<VERSION>-<RELEASE>.noarch.rpm
#
# To install the resulting RPM on a BIG-IP, use build/install-rpm.sh.
# =============================================================================

set -euo pipefail

VERSION="${1:-1.0.0}"
RELEASE="${2:-0001}"
APP_NAME="irule-versioner"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_ROOT="$SCRIPT_DIR/.rpmbuild"
DIST_DIR="$SCRIPT_DIR/dist"

echo "==> Building ${APP_NAME}-${VERSION}-${RELEASE}.noarch.rpm"

# Create rpmbuild directory tree
mkdir -p "$DIST_DIR"
mkdir -p "$BUILD_ROOT"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# ---------------------------------------------------------------------------
# Stage source files into the rpmbuild BUILD directory
# ---------------------------------------------------------------------------
STAGE="$BUILD_ROOT/BUILD/${APP_NAME}"
rm -rf "$STAGE"
mkdir -p "$STAGE/nodejs/lib"
mkdir -p "$STAGE/presentation"

cp "$SRC_DIR/manifest.json"        "$STAGE/"
cp "$SRC_DIR/block_template.json"  "$STAGE/"
cp "$SRC_DIR/nodejs/index.js"      "$STAGE/nodejs/"
cp "$SRC_DIR/nodejs/lib/"*.js      "$STAGE/nodejs/lib/"
cp "$SRC_DIR/presentation/"*.html  "$STAGE/presentation/"

echo "    Staged files:"
find "$STAGE" -type f | sed 's|^|      |'

# ---------------------------------------------------------------------------
# Generate the RPM SPEC file.
#
# STAGE is interpolated as a literal absolute path so rpmbuild does not need
# to resolve %{_builddir} — this avoids a macOS rpmbuild (Homebrew) quirk
# where %{_builddir} expands to a "<n>-<version>-build" subdirectory rather
# than the BUILD root we staged into.
#
# The %install cp uses "${STAGE}/." instead of "${STAGE}/*" to copy directory
# contents reliably without shell glob expansion issues inside the SPEC.
# ---------------------------------------------------------------------------
SPEC_FILE="$BUILD_ROOT/SPECS/${APP_NAME}.spec"

cat > "$SPEC_FILE" << SPEC
Name:       ${APP_NAME}
Version:    ${VERSION}
Release:    ${RELEASE}
Summary:    iRule Versioning Engine for BIG-IP
License:    Proprietary
BuildArch:  noarch
Vendor:     Internal

%description
iApps LX extension that provides version control for BIG-IP iRules.
Snapshot, diff, deploy, and rollback iRules via a built-in GUI.
Supports local filesystem storage, scheduled change detection,
and audit logging.

%install
mkdir -p %{buildroot}/var/config/rest/iapps/${APP_NAME}
cp -r ${STAGE}/. %{buildroot}/var/config/rest/iapps/${APP_NAME}/

%post
DATA_DIR="/var/config/rest/iapps/${APP_NAME}/data"
if [ ! -d "\$DATA_DIR" ]; then
  mkdir -p "\$DATA_DIR"
  touch "\$DATA_DIR/audit.jsonl"
  logger -t irule-versioner "Data directory initialised at \$DATA_DIR"
  echo "irule-versioner: data directory initialised at \$DATA_DIR"
else
  echo "irule-versioner: existing data directory found at \$DATA_DIR — skipping init"
fi
bigstart restart restnoded 2>/dev/null || true

%preun
if [ "\$1" = "0" ]; then
  logger -t irule-versioner "Package removed — version store retained at /var/config/rest/iapps/${APP_NAME}/data"
fi
exit 0

%files
/var/config/rest/iapps/${APP_NAME}/manifest.json
/var/config/rest/iapps/${APP_NAME}/block_template.json
/var/config/rest/iapps/${APP_NAME}/nodejs/index.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/blockUtil.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/configProcessor.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/logger.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/pollWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/rulesWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/settings.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/settingsWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/tmsh.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/versionStore.js
/var/config/rest/iapps/${APP_NAME}/presentation/index.html
SPEC

# ---------------------------------------------------------------------------
# Run rpmbuild
# ---------------------------------------------------------------------------
echo "==> Running rpmbuild..."
rpmbuild \
  --define "_topdir $BUILD_ROOT" \
  --define "_builddir $BUILD_ROOT/BUILD" \
  --define "_rpmdir $BUILD_ROOT/RPMS" \
  -bb "$SPEC_FILE" \
  2>&1 | sed 's/^/    /'

# ---------------------------------------------------------------------------
# Copy output to dist/
# ---------------------------------------------------------------------------
RPM_FILE=$(find "$BUILD_ROOT/RPMS" -name "*.rpm" | head -1)

if [ -z "$RPM_FILE" ]; then
  echo "ERROR: RPM not found after build — check rpmbuild output above"
  exit 1
fi

cp "$RPM_FILE" "$DIST_DIR/"
DIST_RPM="$DIST_DIR/$(basename "$RPM_FILE")"

echo ""
echo "==> Build complete: $DIST_RPM"
echo ""
echo "Install on BIG-IP:"
echo "  BIGIP_PASS=<password> ./build/install-rpm.sh <host> <user> $DIST_RPM"
