#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# webhook-listener.sh — minimal webhook receiver for Rülbased demos
#
# Listens on a port and prints incoming webhook POSTs with headers and
# pretty-printed JSON body. Useful for verifying webhook delivery and
# HMAC signing from a BIG-IP running Rülbased.
#
# Usage:
#   bash webhook-listener.sh [port]
#   # Default port: 9999
#
# Setup:
#   1. Start this listener on a machine reachable from the BIG-IP:
#        bash webhook-listener.sh 9999
#
#   2. In Rülbased Settings → Notifications:
#      - Webhook URL:  http://<this-machine>:9999
#      - Webhook HMAC secret:  (any value, e.g. "demodemo")
#      - Save Settings
#
#   3. Click "Send Test Webhook" — payload appears in this terminal.
#      Then deploy an iRule to see a real "deploy" event.
#
# Requirements: bash, nc (netcat), optionally python for JSON formatting.
# Press Ctrl+C to stop.
# ---------------------------------------------------------------------------
set -euo pipefail

PORT="${1:-9999}"
echo "Listening for webhooks on port ${PORT}..."
echo "Configure Rülbased webhook URL: http://$(hostname -f 2>/dev/null || hostname):${PORT}"
echo "Press Ctrl+C to stop."
echo ""

while true; do
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') — waiting ==="
  { read -r reqline; headers=""; body=""
    while IFS= read -r line; do
      line="${line%%$'\r'}"
      [ -z "$line" ] && break
      headers="${headers}${line}\n"
    done
    clength=$(echo -e "$headers" | grep -i '^content-length:' | awk '{print $2}' | tr -d '[:space:]')
    if [ -n "$clength" ] && [ "$clength" -gt 0 ] 2>/dev/null; then
      body=$(dd bs=1 count="$clength" 2>/dev/null)
    fi
    echo ""
    echo "$reqline"
    echo -e "$headers" | grep -i "x-hub-signature\|content-type\|user-agent"
    if [ -n "$body" ]; then
      echo ""
      echo "Body:"
      echo "$body" | python -m json.tool 2>/dev/null || echo "$body"
    fi
    echo -e "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
  } < <(nc -l "$PORT")
  echo ""
done
