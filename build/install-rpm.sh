#!/usr/bin/env bash
# =============================================================================
# install-rpm.sh
#
# Uploads and installs the Rülbased RPM on a target BIG-IP.
# This is the ONLY script that requires BIG-IP credentials.
#
# NOTE: Use the BIG-IP 'admin' account (or another admin-role account).
#       The 'root' OS account is blocked from iControl REST by design.
#
# Usage:
#   bash ./build/install-rpm.sh <host> <user> <rpm-file>
#
# If BIGIP_PASS is not set in the environment, you will be prompted for
# the password interactively (input is hidden).  Setting BIGIP_PASS in the
# environment is also supported, and preferred for CI/CD where interactive
# input is not possible:
#
#   export BIGIP_PASS=<password>
#   bash ./build/install-rpm.sh <host> <user> <rpm-file>
#
# In a CI/CD pipeline, set BIGIP_PASS from your secrets vault:
#   BIGIP_PASS=${{ secrets.BIGIP_ADMIN_PASS }} bash ./build/install-rpm.sh ...
#
# Example (interactive):
#   bash ./build/install-rpm.sh 192.168.1.245 admin build/dist/rulbased-2.2.0-0001.noarch.rpm
#   Password for admin@192.168.1.245: ******
#
# Prerequisites:
#   - curl available on the build machine
#   - The target BIG-IP must be running TMOS 13.0 or later
#   - User must have the Administrator role in BIG-IP (root does not work
#     for iControl REST — use admin or another admin-role account)
# =============================================================================

set -euo pipefail

BIGIP_HOST="${1:?Usage: bash install-rpm.sh <host> <user> <rpm-file>}"
BIGIP_USER="${2:?Usage: bash install-rpm.sh <host> <user> <rpm-file>}"
RPM_FILE="${3:?Usage: bash install-rpm.sh <host> <user> <rpm-file>}"

# Password: environment variable wins; otherwise prompt interactively.
# Using read -s keeps the input off the terminal and out of shell history.
if [ -z "${BIGIP_PASS:-}" ]; then
  if [ ! -t 0 ]; then
    echo "ERROR: BIGIP_PASS is not set and stdin is not a TTY."
    echo "  Either set BIGIP_PASS=<password> in the environment,"
    echo "  or run the script from an interactive terminal."
    echo ""
    echo "  NOTE: Use the BIG-IP admin account, not root."
    echo "        root is blocked from iControl REST by design."
    exit 1
  fi
  printf "Password for %s@%s: " "${BIGIP_USER}" "${BIGIP_HOST}"
  read -rs BIGIP_PASS
  echo ""
  if [ -z "${BIGIP_PASS:-}" ]; then
    echo "ERROR: password cannot be empty"
    exit 1
  fi
fi

if [ ! -f "$RPM_FILE" ]; then
  echo "ERROR: RPM file not found: $RPM_FILE"
  exit 1
fi

RPM_NAME="$(basename "$RPM_FILE")"
BIGIP_URL="https://${BIGIP_HOST}/mgmt"

# ---------------------------------------------------------------------------
# Helper: check a curl response for auth errors before trying to parse JSON
# ---------------------------------------------------------------------------
check_auth() {
  local response="$1"
  local step="$2"
  if echo "$response" | grep -q "401 Unauthorized"; then
    echo ""
    echo "ERROR: 401 Unauthorized at step: ${step}"
    echo ""
    echo "  Most likely cause: using 'root' instead of an admin-role account."
    echo "  BIG-IP blocks root from iControl REST by design."
    echo "  Try: ./build/install-rpm.sh ${BIGIP_HOST} admin ${RPM_FILE}"
    echo ""
    exit 1
  fi
  if echo "$response" | grep -q "<!DOCTYPE\|<html"; then
    echo ""
    echo "ERROR: BIG-IP returned an HTML error page at step: ${step}"
    echo "Response: ${response}"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Step 1: Upload the RPM via iControl REST file transfer endpoint
# ---------------------------------------------------------------------------
echo "==> Uploading ${RPM_NAME} to ${BIGIP_HOST}..."

RPM_SIZE=$(wc -c < "$RPM_FILE" | tr -d ' ')
CONTENT_RANGE="0-$((RPM_SIZE - 1))/${RPM_SIZE}"

UPLOAD_RESPONSE=$(curl -sk \
  -u "${BIGIP_USER}:${BIGIP_PASS}" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Range: ${CONTENT_RANGE}" \
  -H "Content-Length: ${RPM_SIZE}" \
  -H "Connection: keep-alive" \
  -X POST \
  "${BIGIP_URL}/shared/file-transfer/uploads/${RPM_NAME}" \
  --data-binary "@${RPM_FILE}")

check_auth "$UPLOAD_RESPONSE" "file upload"

LOCAL_PATH=$(echo "$UPLOAD_RESPONSE" | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('localFilePath','unknown'))" 2>/dev/null || echo "unknown")
echo "    Uploaded to: ${LOCAL_PATH}"

# ---------------------------------------------------------------------------
# Step 2: Trigger the install task
# ---------------------------------------------------------------------------
echo "==> Triggering package install task..."

TASK_RESPONSE=$(curl -sk \
  -u "${BIGIP_USER}:${BIGIP_PASS}" \
  -H "Content-Type: application/json" \
  -X POST \
  "${BIGIP_URL}/shared/iapp/package-management-tasks" \
  -d "{\"operation\":\"INSTALL\",\"packageFilePath\":\"/var/config/rest/downloads/${RPM_NAME}\"}")

check_auth "$TASK_RESPONSE" "install task creation"

TASK_ID=$(echo "$TASK_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception as e:
    raise SystemExit('ERROR: Could not parse install task response: ' + str(e))
tid = d.get('id', '')
if not tid:
    raise SystemExit('ERROR: No task ID in response.\nFull response: ' + str(d))
print(tid)
")

echo "==> Install task ID: ${TASK_ID} — polling for completion..."

# ---------------------------------------------------------------------------
# Step 3: Poll until FINISHED or FAILED
# ---------------------------------------------------------------------------
ATTEMPTS=0
MAX_ATTEMPTS=40  # 40 x 5s = ~3 minutes max

while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  sleep 5
  ATTEMPTS=$((ATTEMPTS + 1))

  TASK_STATUS=$(curl -sk \
    -u "${BIGIP_USER}:${BIGIP_PASS}" \
    "${BIGIP_URL}/shared/iapp/package-management-tasks/${TASK_ID}")

  check_auth "$TASK_STATUS" "task status poll"

  STATUS=$(echo "$TASK_STATUS" | python3 -c \
    "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")

  echo "    [${ATTEMPTS}/${MAX_ATTEMPTS}] ${STATUS}"

  if [ "$STATUS" = "FINISHED" ]; then
    POST_INSTALL_PATH="/var/config/rest/iapps/rulbased/build/post-install.sh"
    echo ""
    echo "==> Step 2 complete: RPM uploaded and installed."
    echo ""
    echo "==> Step 3: Run post-install script on the BIG-IP (required)"
    echo ""
    echo "    ssh root@${BIGIP_HOST} bash ${POST_INSTALL_PATH}"
    echo ""
    echo "    This creates /shared/rulbased-backups with the correct"
    echo "    ownership (restnoded:webusers, 0750) so backup exports can"
    echo "    be retained on-device. Idempotent — safe to re-run."
    echo ""
    echo "==> Step 4: Verify the install"
    echo ""
    echo "    ssh root@${BIGIP_HOST} \"grep 'has started' /var/log/restnoded/restnoded.log | grep -i rulbased\""
    echo "    curl -sk -u ${BIGIP_USER}:'***' ${BIGIP_URL}/shared/rulbased/rules | jq ."
    echo ""
    echo "==> Step 5: Access the GUI"
    echo ""
    echo "    ${BIGIP_URL}/shared/rulbased/ui"
    echo ""
    echo "See README.md \"Installing\" for full details."
    exit 0
  fi

  if [ "$STATUS" = "FAILED" ]; then
    echo ""
    echo "ERROR: Install failed."
    echo "$TASK_STATUS" | python3 -m json.tool 2>/dev/null || echo "$TASK_STATUS"
    exit 1
  fi
done

echo ""
echo "ERROR: Install timed out after $((MAX_ATTEMPTS * 5)) seconds"
echo "Check BIG-IP logs: tail -f /var/log/restnoded/restnoded.log"
exit 1
