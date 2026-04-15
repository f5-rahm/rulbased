#!/usr/bin/env bash
# =============================================================================
# install-rpm.sh
#
# Uploads and installs the irule-versioner RPM on a target BIG-IP.
# This is the ONLY script that requires BIG-IP credentials.
#
# NOTE: Use the BIG-IP 'admin' account (or another admin-role account).
#       The 'root' OS account is blocked from iControl REST by design.
#
# The password is read from the BIGIP_PASS environment variable — never
# passed as a command-line argument — so it does not appear in shell
# history, ps output, or CI logs.
#
# Usage:
#   export BIGIP_PASS=<password>
#   ./build/install-rpm.sh <host> <user> <rpm-file>
#
# Example:
#   export BIGIP_PASS=MySecret
#   ./build/install-rpm.sh 192.168.1.245 admin build/dist/irule-versioner-1.0.0-0001.noarch.rpm
#
# In a CI/CD pipeline, set BIGIP_PASS from your secrets vault:
#   BIGIP_PASS=${{ secrets.BIGIP_ADMIN_PASS }} ./build/install-rpm.sh ...
#
# Prerequisites:
#   - curl available on the build machine
#   - The target BIG-IP must be running TMOS 13.0 or later
#   - User must have the Administrator role in BIG-IP (root does not work
#     for iControl REST — use admin or another admin-role account)
# =============================================================================

set -euo pipefail

BIGIP_HOST="${1:?Usage: install-rpm.sh <host> <user> <rpm-file>}"
BIGIP_USER="${2:?Usage: install-rpm.sh <host> <user> <rpm-file>}"
RPM_FILE="${3:?Usage: install-rpm.sh <host> <user> <rpm-file>}"

# Password must come from the environment — never a positional arg
: "${BIGIP_PASS:?Set BIGIP_PASS environment variable first:
  export BIGIP_PASS=<password>
  ./build/install-rpm.sh <host> <user> <rpm-file>

NOTE: Use the BIG-IP admin account, not root.
      root is blocked from iControl REST by design.}"

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
    echo ""
    echo "==> Install complete."
    echo ""
    echo "Verify installation:"
    echo "  curl -sk -u ${BIGIP_USER}:'***' ${BIGIP_URL}/toc | grep irule-versioner"
    echo "  curl -sk -u ${BIGIP_USER}:'***' ${BIGIP_URL}/shared/irule-versioner/rules"
    echo ""
    echo "Watch logs on BIG-IP:"
    echo "  tail -f /var/log/restnoded/restnoded.log | grep irule-versioner"
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
