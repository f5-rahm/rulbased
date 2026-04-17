#!/usr/bin/env bash
# =============================================================================
# post-install.sh
#
# Manual post-install / repair script for Rülbased on BIG-IP.
#
# Run this via SSH as root if the RPM %post scriptlet did not complete
# (e.g. because the iApps LX install pipeline skipped scriptlets on your
# TMOS version).  It is safe to run any time — all operations are
# idempotent.
#
# What it does:
#   1. Confirms Rülbased is installed and the data directory exists
#   2. Creates /shared/rulbased-backups if missing (owned restnode:webusers,
#      mode 0750) so the export endpoint can write on-device copies
#   3. Writes a diagnostic marker at
#      /var/config/rest/iapps/rulbased-post-install.log for future reference
#
# Usage (from the BIG-IP itself):
#   /var/config/rest/iapps/rulbased/build/post-install.sh
#
# Usage (from a remote build/admin host):
#   ssh root@<bigip> bash < build/post-install.sh
# =============================================================================

set -euo pipefail

APP_NAME="rulbased"
DATA_DIR="/var/config/rest/iapps/${APP_NAME}/data"
BACKUP_DIR="/shared/${APP_NAME}-backups"
MARKER="/var/config/rest/iapps/${APP_NAME}-post-install.log"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must be run as root (current uid: $(id -u))"
  echo "  From SSH:  ssh root@<bigip> bash /var/config/rest/iapps/${APP_NAME}/build/post-install.sh"
  exit 1
fi

echo "==> ${APP_NAME} post-install / repair script"

# Step 1: confirm package layout exists
if [ ! -d "/var/config/rest/iapps/${APP_NAME}" ]; then
  echo "ERROR: package directory /var/config/rest/iapps/${APP_NAME} not found"
  echo "  Is the RPM installed? Check:"
  echo "    curl -sk -u admin:\$PW https://localhost/mgmt/shared/iapp/global-installed-packages | grep ${APP_NAME}"
  exit 1
fi
echo "    package directory: /var/config/rest/iapps/${APP_NAME}  OK"

# Step 2: data directory
if [ ! -d "${DATA_DIR}" ]; then
  mkdir -p "${DATA_DIR}"
  touch "${DATA_DIR}/audit.jsonl"
  echo "    data directory: ${DATA_DIR}  CREATED"
else
  echo "    data directory: ${DATA_DIR}  already exists"
fi

# Step 3: backup directory
if [ ! -d "${BACKUP_DIR}" ]; then
  mkdir -p "${BACKUP_DIR}"
  echo "    backup directory: ${BACKUP_DIR}  CREATED"
else
  echo "    backup directory: ${BACKUP_DIR}  already exists"
fi

# Ownership / mode — always enforce, harmless if already correct.
# 198 = restnode (restnoded process user), 498 = webusers
chown 198:498 "${BACKUP_DIR}"
chmod 0750    "${BACKUP_DIR}"
echo "    backup directory ownership/mode: 198:498 / 0750  OK"

# Step 4: refresh marker so we can tell this script ran
{
  echo "=== ${APP_NAME} post-install.sh run ==="
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  echo "uid=$(id -u) user=$(whoami)"
  echo "source=post-install.sh"
  echo "data_dir=${DATA_DIR}"
  echo "backup_dir=${BACKUP_DIR}"
  echo "=== done ==="
} >> "${MARKER}"

# Step 5: show current state for the operator
echo ""
echo "==> Current state:"
ls -ld "${DATA_DIR}" "${BACKUP_DIR}" | sed 's|^|    |'
echo ""
echo "==> Done.  Marker written to ${MARKER}"
echo ""
echo "To verify Rülbased is responding:"
echo "  curl -sk -u admin:\$PW https://localhost/mgmt/shared/${APP_NAME}/rules | head"
