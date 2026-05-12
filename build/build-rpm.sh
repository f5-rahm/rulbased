#!/usr/bin/env bash
# =============================================================================
# build-rpm.sh
#
# Builds the Rülbased iApps LX RPM locally using rpmbuild.
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
#   ./build/build-rpm.sh              # uses defaults: 2.0.0-0001
#   ./build/build-rpm.sh 2.0.0 0003
#
# Output:
#   build/dist/rulbased-<VERSION>-<RELEASE>.noarch.rpm
#
# To install the resulting RPM on a BIG-IP, use build/install-rpm.sh.
# =============================================================================

set -euo pipefail

VERSION="${1:-2.2.0}"
RELEASE="${2:-0001}"
APP_NAME="rulbased"

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
mkdir -p "$STAGE/build"

cp "$SRC_DIR/manifest.json"        "$STAGE/"
cp "$SRC_DIR/block_template.json"  "$STAGE/"
cp "$SRC_DIR/nodejs/index.js"      "$STAGE/nodejs/"
cp "$SRC_DIR/nodejs/lib/"*.js      "$STAGE/nodejs/lib/"
cp "$SRC_DIR/presentation/"*.html  "$STAGE/presentation/"

# Stage post-install.sh — shipped with the RPM so operators can run it
# via SSH if the %post scriptlet was skipped by the iApps LX install pipeline.
cp "$SRC_DIR/build/post-install.sh" "$STAGE/build/"
chmod 0755 "$STAGE/build/post-install.sh"

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
#
# %post responsibilities:
#   1. Create the data directory (survives upgrades; not in %files).
#   2. Create /shared/rulbased-backups owned by restnode (uid 198) so the
#      export endpoint can write backup archives there.  Group 498 is the
#      'webusers' group on BIG-IP; mode 0750 matches how BIG-IP itself
#      protects other /shared subdirectories.
#   3. Restart restnoded so the new workers are picked up.
# ---------------------------------------------------------------------------
SPEC_FILE="$BUILD_ROOT/SPECS/${APP_NAME}.spec"

cat > "$SPEC_FILE" << SPEC
Name:       ${APP_NAME}
Version:    ${VERSION}
Release:    ${RELEASE}
Summary:    Rülbased — Version control for BIG-IP iRules
License:    Proprietary
BuildArch:  noarch
Vendor:     Internal

%description
Rülbased is an iApps LX extension that provides version control for BIG-IP
iRules. Snapshot, diff, deploy, and rollback iRules via a built-in GUI.
Supports local filesystem storage, scheduled change detection, syslog and
webhook notifications, backup/restore, and audit logging.

%install
mkdir -p %{buildroot}/var/config/rest/iapps/${APP_NAME}
cp -r ${STAGE}/. %{buildroot}/var/config/rest/iapps/${APP_NAME}/

%post
# Marker file — tangible proof that %post executed.  If this file does not
# exist on disk after install, the scriptlet was skipped by the iApps LX
# install pipeline (or never ran for some other reason) and the operator
# needs to run build/post-install.sh manually.
MARKER="/var/config/rest/iapps/${APP_NAME}-post-install.log"
{
  echo "=== ${APP_NAME} %post scriptlet run ==="
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  echo "uid=\$(id -u) euid=\$(id -u -n) whoami=\$(whoami)"
  echo "shell=\$0"
} > "\$MARKER" 2>&1 || true

DATA_DIR="/var/config/rest/iapps/${APP_NAME}/data"
if [ ! -d "\$DATA_DIR" ]; then
  mkdir -p "\$DATA_DIR"
  touch "\$DATA_DIR/audit.jsonl"
  logger -t ${APP_NAME} "Data directory initialised at \$DATA_DIR"
  echo "${APP_NAME}: data directory initialised at \$DATA_DIR"
  echo "data_dir_created=\$DATA_DIR" >> "\$MARKER"
else
  echo "${APP_NAME}: existing data directory found at \$DATA_DIR — skipping init"
  echo "data_dir_preexisting=\$DATA_DIR" >> "\$MARKER"
fi

# Backup directory used by /rules/export. Must be writable by restnoded
# (uid 198, restnode:webusers 198:498).
BACKUP_DIR="/shared/${APP_NAME}-backups"
if [ ! -d "\$BACKUP_DIR" ]; then
  if mkdir -p "\$BACKUP_DIR" 2>>"\$MARKER"; then
    logger -t ${APP_NAME} "Backup directory created at \$BACKUP_DIR"
    echo "${APP_NAME}: backup directory created at \$BACKUP_DIR"
    echo "backup_dir_created=\$BACKUP_DIR" >> "\$MARKER"
  else
    logger -t ${APP_NAME} "Backup directory creation FAILED at \$BACKUP_DIR"
    echo "${APP_NAME}: WARNING backup directory creation FAILED at \$BACKUP_DIR" >&2
    echo "backup_dir_mkdir_failed=\$BACKUP_DIR" >> "\$MARKER"
  fi
else
  echo "backup_dir_preexisting=\$BACKUP_DIR" >> "\$MARKER"
fi
chown 198:498 "\$BACKUP_DIR" 2>>"\$MARKER" || echo "backup_dir_chown_failed" >> "\$MARKER"
chmod 0750    "\$BACKUP_DIR" 2>>"\$MARKER" || echo "backup_dir_chmod_failed" >> "\$MARKER"

echo "=== %post complete ===" >> "\$MARKER"

# Do NOT call 'bigstart restart restnoded' here — the iApps LX framework
# manages restnoded's lifecycle as part of the install transaction.  Calling
# it ourselves races with the framework and has been observed to truncate
# the tail of this scriptlet.  If %post is silently skipped entirely by the
# install pipeline (possible on some TMOS versions), the operator should
# run build/post-install.sh via SSH to complete the install.

exit 0

%preun
if [ "\$1" = "0" ]; then
  logger -t ${APP_NAME} "Package removed — version store retained at /var/config/rest/iapps/${APP_NAME}/data"
fi
exit 0

%files
/var/config/rest/iapps/${APP_NAME}/manifest.json
/var/config/rest/iapps/${APP_NAME}/block_template.json
/var/config/rest/iapps/${APP_NAME}/nodejs/index.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/bigipClient.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/blockUtil.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/configProcessor.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/logger.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/migrations.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/notifier.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/pollWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/rulesWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/settings.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/settingsWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/tmsh.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/uiWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/versionStore.js
/var/config/rest/iapps/${APP_NAME}/presentation/app.html
/var/config/rest/iapps/${APP_NAME}/presentation/index.html
%attr(0755, -, -) /var/config/rest/iapps/${APP_NAME}/build/post-install.sh
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
