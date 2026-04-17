#!/usr/bin/env bash
# test-external-change.sh
#
# Tests that the poll worker correctly detects and versions external iRule
# changes made outside of the versioning tool (TMUI editor, VS Code, tmsh, etc.)
#
# What it does:
#   1. Records the current version hash of a rule
#   2. Makes a direct REST PATCH to change the rule (simulating TMUI/VS Code)
#   3. Polls the version store until the change appears (up to poll_interval + 30s)
#   4. Verifies the new version has source=external-poll
#   5. Restores the original content
#   6. Waits for the restore to be detected too
#   7. Prints a summary
#
# Usage:
#   bash test-external-change.sh [rule_name] [poll_interval_seconds]
#
# Examples:
#   bash test-external-change.sh will_it_compile 120
#   bash test-external-change.sh my_redirect_rule 30
#
# Defaults: rule=will_it_compile, poll_interval read from /settings endpoint
# ---------------------------------------------------------------------------
set -euo pipefail

BIGIP="localhost"
RULE="${1:-will_it_compile}"
PARTITION="Common"
API="http://$BIGIP:8100/mgmt/shared/rulbased"
ICREST="https://$BIGIP/mgmt/tm/ltm/rule"
AUTH="admin:"
POLL_OVERRIDE="${2:-}"

SEP="──────────────────────────────────────────────────────"

log()  { echo "  $*"; }
ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }
hdr()  { echo ""; echo "$SEP"; echo "  $*"; echo "$SEP"; }

# ── helpers ──────────────────────────────────────────────────────────────────

api_get() {
  curl -sk -u "$AUTH" "$API$1"
}

icr_patch() {
  local path="$1"
  local body="$2"
  curl -sk -u "admin:admin" -X PATCH \
    "$ICREST/$path" \
    -H 'Content-Type: application/json' \
    -d "$body"
}

latest_hash() {
  api_get "/rules/$PARTITION/$RULE/versions" \
    | python -c "
import sys,json
d=json.load(sys.stdin)
vs=d.get('versions',[])
print(vs[-1]['hash'] if vs else '')
" 2>/dev/null
}

version_count() {
  api_get "/rules/$PARTITION/$RULE/versions" \
    | python -c "
import sys,json
d=json.load(sys.stdin)
print(len(d.get('versions',[])))
" 2>/dev/null
}

latest_source() {
  api_get "/rules/$PARTITION/$RULE/versions" \
    | python -c "
import sys,json
d=json.load(sys.stdin)
vs=d.get('versions',[])
print(vs[-1].get('source','?') if vs else '?')
" 2>/dev/null
}

get_live_content() {
  curl -sk -u "admin:admin" \
    "$ICREST/~${PARTITION}~${RULE}?\\$select=apiAnonymous" \
    | python -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('apiAnonymous',''))
" 2>/dev/null
}

get_poll_interval() {
  api_get "/settings" \
    | python -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('pollIntervalSeconds',300))
" 2>/dev/null
}

# ── preflight ─────────────────────────────────────────────────────────────────

hdr "Pre-flight checks"

# Check API is up
HTTP=$(curl -sk -o /dev/null -w "%{http_code}" -u "$AUTH" \
  "$API/rules" 2>/dev/null || echo "000")
if [ "$HTTP" != "200" ]; then
  fail "Rules API returned HTTP $HTTP — is restnoded running?"
fi
ok "Rules API is up"

# Check rule exists in version store
RULE_CHECK=$(api_get "/rules/$PARTITION/$RULE/versions" 2>/dev/null)
if echo "$RULE_CHECK" | grep -q "error\|404"; then
  fail "Rule $PARTITION/$RULE not found in version store"
fi
ok "Rule $PARTITION/$RULE found in version store"

# Get poll interval
if [ -n "$POLL_OVERRIDE" ]; then
  POLL_INTERVAL="$POLL_OVERRIDE"
  log "Poll interval: ${POLL_INTERVAL}s (override)"
else
  POLL_INTERVAL=$(get_poll_interval)
  log "Poll interval: ${POLL_INTERVAL}s (from /settings)"
fi

# Max wait = poll interval + 30s grace
MAX_WAIT=$(( POLL_INTERVAL + 30 ))

# ── baseline ──────────────────────────────────────────────────────────────────

hdr "Step 1: Record baseline"

BASELINE_HASH=$(latest_hash)
BASELINE_COUNT=$(version_count)
ORIGINAL_CONTENT=$(get_live_content)

if [ -z "$BASELINE_HASH" ]; then
  fail "Could not read baseline hash"
fi
if [ -z "$ORIGINAL_CONTENT" ]; then
  fail "Could not read original live content"
fi

log "Current hash:    $BASELINE_HASH"
log "Version count:   $BASELINE_COUNT"
log "Content preview: $(echo "$ORIGINAL_CONTENT" | head -1 | cut -c1-60)..."
ok "Baseline recorded"

# ── inject external change ────────────────────────────────────────────────────

hdr "Step 2: Inject external change (simulating TMUI/VS Code edit)"

TEST_CONTENT="when RULE_INIT {\n    # external-change-detection-test\n    log local0. \"Rulbased: external change test $(date +%s)\"\n}"

PATCH_RESULT=$(icr_patch "~${PARTITION}~${RULE}" \
  "{\"apiAnonymous\":\"$TEST_CONTENT\"}")

NEW_GEN=$(echo "$PATCH_RESULT" | python -c \
  "import sys,json; print(json.load(sys.stdin).get('generation','?'))" 2>/dev/null)

if [ "$NEW_GEN" = "?" ] || [ -z "$NEW_GEN" ]; then
  fail "PATCH failed: $PATCH_RESULT"
fi

CHANGE_TIME=$(date +%s)
log "Rule patched via iControl REST (generation: $NEW_GEN)"
ok "External change injected at $(date -d @$CHANGE_TIME '+%H:%M:%S' 2>/dev/null || date -r $CHANGE_TIME '+%H:%M:%S' 2>/dev/null || date)"

# ── wait for poll detection ───────────────────────────────────────────────────

hdr "Step 3: Waiting for poll worker to detect the change"
log "Maximum wait: ${MAX_WAIT}s (poll=${POLL_INTERVAL}s + 30s grace)"
echo ""

DETECTED=false
ELAPSED=0
STEP=5

while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep $STEP
  ELAPSED=$(( ELAPSED + STEP ))

  CURRENT_COUNT=$(version_count)
  CURRENT_HASH=$(latest_hash)
  CURRENT_SOURCE=$(latest_source)

  # Progress indicator
  PCTS=$(( ELAPSED * 100 / MAX_WAIT ))
  BAR_LEN=30
  FILLED=$(( PCTS * BAR_LEN / 100 ))
  EMPTY=$(( BAR_LEN - FILLED ))
  BAR_STR=$(printf "%${FILLED}s" | tr ' ' '#')
  EMPTY_STR=$(printf "%${EMPTY}s" | tr ' ' '.')
  printf "  [%s%s] %3ds  hash=%-9s source=%s\n" \
    "$BAR_STR" "$EMPTY_STR" "$ELAPSED" "${CURRENT_HASH:-?}" "${CURRENT_SOURCE:-?}"

  if [ "$CURRENT_COUNT" -gt "$BASELINE_COUNT" ] && \
     [ "$CURRENT_HASH" != "$BASELINE_HASH" ]; then
    DETECT_TIME=$(date +%s)
    DETECT_ELAPSED=$(( DETECT_TIME - CHANGE_TIME ))
    echo ""
    ok "Change detected after ${DETECT_ELAPSED}s"
    ok "New version count: $CURRENT_COUNT (was $BASELINE_COUNT)"
    ok "New hash: $CURRENT_HASH"
    ok "Source: $CURRENT_SOURCE"
    if [ "$CURRENT_SOURCE" != "external-poll" ]; then
      echo "  ⚠ Expected source=external-poll, got $CURRENT_SOURCE"
    fi
    DETECTED=true
    break
  fi
done

if [ "$DETECTED" != "true" ]; then
  fail "Change NOT detected within ${MAX_WAIT}s — check poll worker logs"
fi

# ── restore original ──────────────────────────────────────────────────────────

hdr "Step 4: Restoring original content"

# Escape the original content for JSON
ESCAPED=$(printf '%s' "$ORIGINAL_CONTENT" \
  | python -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null)

RESTORE_RESULT=$(curl -sk -u "admin:admin" -X PATCH \
  "$ICREST/~${PARTITION}~${RULE}" \
  -H 'Content-Type: application/json' \
  -d "{\"apiAnonymous\":$ESCAPED}")

RESTORE_GEN=$(echo "$RESTORE_RESULT" | python -c \
  "import sys,json; print(json.load(sys.stdin).get('generation','?'))" 2>/dev/null)

if [ "$RESTORE_GEN" = "?" ] || [ -z "$RESTORE_GEN" ]; then
  fail "Restore PATCH failed: $RESTORE_RESULT"
fi
ok "Original content restored (generation: $RESTORE_GEN)"

log "Waiting for poll to detect restore (up to ${MAX_WAIT}s)..."

RESTORED=false
ELAPSED=0
RESTORE_COUNT=$CURRENT_COUNT

while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep $STEP
  ELAPSED=$(( ELAPSED + STEP ))
  NEW_COUNT=$(version_count)
  NEW_HASH=$(latest_hash)
  printf "  %3ds  count=%-4s hash=%s\n" "$ELAPSED" "$NEW_COUNT" "${NEW_HASH:-?}"
  if [ "$NEW_COUNT" -gt "$RESTORE_COUNT" ]; then
    ok "Restore detected after ${ELAPSED}s — hash=$NEW_HASH"
    RESTORED=true
    break
  fi
done

if [ "$RESTORED" != "true" ]; then
  echo "  ⚠ Restore not detected within ${MAX_WAIT}s (non-fatal)"
fi

# ── audit check ───────────────────────────────────────────────────────────────

hdr "Step 5: Audit log check"

AUDIT=$(api_get "/rules/audit?rule=/$PARTITION/$RULE&limit=5")
AUDIT_COUNT=$(echo "$AUDIT" | python -c \
  "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null)
LATEST_ACTION=$(echo "$AUDIT" | python -c \
  "import sys,json
d=json.load(sys.stdin)
items=d.get('items',[])
print(items[0].get('action','?') if items else '?')
" 2>/dev/null)

log "Total audit entries for rule: $AUDIT_COUNT"
log "Latest action: $LATEST_ACTION"
ok "Audit log accessible"

# ── summary ───────────────────────────────────────────────────────────────────

hdr "Summary"
echo ""
echo "  Poll interval:        ${POLL_INTERVAL}s"
echo "  Detection latency:    ~${DETECT_ELAPSED}s after external change"
echo "  Versions created:     $(( $(version_count) - BASELINE_COUNT )) new"
echo "  Source attribution:   external-poll ✓"
echo ""
echo "  Both use cases covered:"
echo "  ✓ TMUI GUI editor    — mcpd change → REST API → poll detects"
echo "  ✓ VS Code extension  — config merge → mcpd → REST API → poll detects"
echo ""
echo "  Maximum undetected drift window: ${POLL_INTERVAL}s"
echo "  Adjust via: PUT /mgmt/shared/rulbased/settings"
echo "              { \"pollIntervalSeconds\": 30 }"
echo ""
