# Rülbased — iApps LX Extension for BIG-IP

Version control for BIG-IP iRules, running entirely on-device. Snapshot, diff,
deploy, and rollback iRules through a built-in GUI served directly from the
BIG-IP management plane — no external dependencies, no agents, no added
infrastructure.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Directory structure](#directory-structure)
- [Building the RPM](#building-the-rpm)
- [Installing](#installing)
- [Verifying the install](#verifying-the-install)
- [Upgrading](#upgrading)
- [Uninstalling](#uninstalling)
- [Re-baselining](#re-baselining)
- [Development workflow](#development-workflow)
- [REST API reference](#rest-api-reference)
- [Version store layout](#version-store-layout)
- [Settings reference](#settings-reference)
- [Running unit tests](#running-unit-tests)
- [Key design decisions](#key-design-decisions)

---

## Features

### Phase 1 — Core versioning
- Automatic baseline snapshot of all iRules on first install
- Local filesystem version store (JSON manifest + TCL blobs per rule)
- Git-style versioning: short SHA-1 hash, author, timestamp, commit message
- Scheduled polling for external changes (default: every 5 minutes)
- REST API: list rules, version history, fetch content, diff, manual snapshot
- Embedded summary widget in BIG-IP TMUI
- iControl REST write path (`PATCH /mgmt/tm/ltm/rule`) — no tmsh permission issues
- Append-only audit log (JSON Lines)

### Phase 2 — Full-page GUI
- Full-page master-detail SPA at `https://<bigip>/mgmt/shared/irule-versioner/ui`
- Searchable iRule list with flat / by-partition grouping toggle
- Overview tab: live TCL viewer with CodeMirror syntax highlighting
- Inline editor: click Edit to modify a rule, Save & Deploy deploys atomically
- History tab: version timeline, two-version compare, side-by-side colour-coded diff
- Draggable resize handle between version list and diff pane
- Two-step deploy flow: diff preview + mandatory change reason field
- Audit tab: per-rule filtered audit log, paginated
- In-GUI toast notifications (colour-coded, 5 s auto-dismiss, stacks to 3)
- Configurable retention policy per rule (unlimited / count / age)
- TMUI light/dark theme detection with live switching

### Phase 3 — Enhanced editor: iRules syntax + click-to-docs
- iRules-aware CodeMirror overlay on top of the base TCL mode
- **Events** (`HTTP_REQUEST`, `CLIENT_ACCEPTED`, etc.) highlighted in F5 red (`#E4002B`)
- **Namespace prefixes + `::` separator** (`HTTP::`) also in F5 red
- **Namespace subcommands** (`uri`, `sessionid`, etc.) in jade green (`#009639`)
- **Standard TCL commands** (`string`, `lindex`, `foreach`, etc.) underlined in their default colour when TCL links are enabled
- `$variable::...` constructs correctly excluded from highlighting
- Vocabulary sourced directly from CloudDocs (~130 events, ~75 namespace prefixes with full command lists)
- Dotted underline + pointer cursor on all token classes when the corresponding link setting is on — immediately signals what is clickable
- **Click-to-docs**: click any highlighted token to open the reference page in a new tab — works in both read-only and edit mode
  - iRules events → `https://clouddocs.f5.com/api/irules/<EVENT>.html`
  - Namespace commands → `https://clouddocs.f5.com/api/irules/<NS>__<cmd>.html`
  - Standard TCL commands → `https://www.tcl-lang.org/man/tcl8.4/TclCmd/<cmd>.htm`
- All link types independently togglable in Settings → Editor (both on by default)
- Settings loaded on page startup — all toggles take effect immediately after a hard refresh without opening the settings modal
- Debug logging toggle in Settings → Editor (off by default) — logs click target, coordinates, and resolved URL to the browser console

### Phase 4 — Dashboard + Rülbased rebrand
- **Dashboard homepage** — shown on initial load; click the header title to return from any rule-detail view
- Product description and feature summary in the dashboard intro card
- **System health grid** — rules tracked, drifted, with history, not yet tracked
- **Recent activity feed** — last N audit entries across all rules, with action badges; clicking a row navigates to the rule
- **Changelog panel** — release history inlined in the dashboard
- **Configurable activity feed limit** (`dashboardAuditLimit`, default 15) in Settings → Dashboard
- **Rülbased branding** — "Rül" in white, "based" in F5 blue italic (`#0072b0`)

### Phase 5 — Syslog + webhook notifications
- **Syslog** on every deploy, rollback, and (optionally) external drift event — written to `/var/log/ltm` via `local0.notice`; tag `irule-versioner` for easy grepping
- **Webhook HTTP/HTTPS POST** to any URL (Slack incoming webhook, Teams, PagerDuty, custom endpoint) with structured JSON payload
- **HMAC-SHA256 signing** — optional `X-Hub-Signature-256` header when a webhook secret is configured, using the same format as GitHub webhooks
- **Retry logic** — 3 attempts with 5 s async backoff; total failure recorded in the audit log as a `webhook-failed` entry
- **`webhookOnDrift` toggle** — webhook on external-change events is off by default to avoid noise; syslog always fires on drift when syslog is enabled
- **Test endpoints** — `GET /settings/test-syslog` and `GET /settings/test-webhook` for field diagnostics without needing to trigger a real deploy
- **Test Webhook button** in the Settings panel

---

## Requirements

| Component | Version |
|-----------|---------|
| BIG-IP TMOS | 13.0 or later (tested on 14.x and 21.x) |
| Node.js (restnoded) | 6.x (embedded in TMOS — no install needed) |
| rpmbuild (build machine only) | Any recent version |
| curl (build machine only) | Any recent version |

The BIG-IP user account used for install must have the **Administrator** role.

---

## Directory structure

```
irule-versioner/
├── PLANNING.md                  ← project spec, design decisions, phase roadmap
├── README.md                    ← this file
├── manifest.json                ← iApps LX package tag
├── block_template.json          ← block input/output property schema
├── nodejs/
│   ├── index.js                 ← restnoded entry point
│   └── lib/
│       ├── bigipClient.js       ← iControl REST reads + writes via localhost:8100
│       ├── blockUtil.js         ← iApps LX state transition helpers
│       ├── configProcessor.js   ← iApps LX block lifecycle
│       ├── logger.js            ← restnoded logger wrapper
│       ├── notifier.js          ← syslog + webhook notifications (Phase 5)
│       ├── pollWorker.js        ← scheduled change detection
│       ├── rulesWorker.js       ← REST API: /rules/*
│       ├── settings.js          ← in-memory settings with persistence
│       ├── settingsWorker.js    ← REST API: /settings + /settings/test-*
│       ├── tmsh.js              ← tmsh child process wrapper
│       ├── uiWorker.js          ← static file server: /ui/*
│       └── versionStore.js      ← filesystem version store
├── presentation/
│   ├── index.html               ← embedded summary widget (shown in TMUI)
│   └── app.html                 ← full-page GUI (Phase 2+), CodeMirror inlined
├── build/
│   ├── build-rpm.sh             ← local RPM build, no BIG-IP needed
│   ├── bundle-codemirror.sh     ← build-machine script for CodeMirror vendor bundle
│   └── install-rpm.sh           ← upload and install on BIG-IP
└── test/
    ├── unit.js                  ← unit tests (16 passing, no framework required)
    └── test-external-change.sh  ← end-to-end external change detection test
```

---

## Building the RPM

```bash
# Install rpmbuild if needed:
#   macOS:         brew install rpm
#   RHEL/CentOS:   sudo yum install rpm-build
#   Ubuntu/Debian: sudo apt install rpm

chmod +x build/build-rpm.sh
./build/build-rpm.sh 1.0.0 0001
# Output: build/dist/irule-versioner-1.0.0-0001.noarch.rpm
```

Increment the release number (`0002`, `0003`) for patch updates; increment the
version for feature releases.

---

## Installing

```bash
export BIGIP_PASS=<password>
chmod +x build/install-rpm.sh
./build/install-rpm.sh <host> admin build/dist/irule-versioner-1.0.0-0001.noarch.rpm
```

**What happens during install:**

1. RPM is uploaded to `/var/config/rest/downloads/` on the BIG-IP.
2. iControl REST package-management-tasks installs the RPM under `/var/config/rest/iapps/irule-versioner/`.
3. restnoded restarts and picks up the new workers.
4. `onStart` creates the data directory, baselines all iRules, starts the poll worker.

**The version store data directory is NOT managed by the RPM** — upgrading or
uninstalling the package never deletes your version history.

**Accessing the GUI:**
```
https://<bigip>/mgmt/shared/irule-versioner/ui
```

---

## Verifying the install

```bash
# All 4 workers should appear
ssh root@<BIGIP> "grep 'has started' /var/log/restnoded/restnoded.log | grep irule-versioner"
# Expected lines:
#   ConfigProcessor   /shared/iapp/processors/irule-versioner
#   RulesWorker       /shared/irule-versioner/rules
#   SettingsWorker    /shared/irule-versioner/settings
#   UiWorker          /shared/irule-versioner/ui

# Baseline completion
ssh root@<BIGIP> "grep 'baseline complete' /var/log/restnoded/restnoded.log"

# Rules list
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/irule-versioner/rules \
  | python3 -m json.tool
```

---

## Upgrading

### Upgrading Rülbased (same TMOS version)

```bash
export BIGIP_PASS=<password>
./build/install-rpm.sh <host> admin build/dist/irule-versioner-1.1.0-0001.noarch.rpm
```

The data directory is preserved across Rülbased upgrades. A re-baseline is not
performed — existing history is intact.

### Before a TMOS version upgrade

**The `/var/config/rest/iapps/` directory is wiped during a TMOS upgrade**,
including the `data/` subdirectory containing all version history. Back up
your data to the `/shared/` partition (which survives upgrades) before
upgrading TMOS:

```bash
# Run on BIG-IP before upgrading TMOS
tar -czf /shared/rulbased-data-backup-$(date +%Y%m%d).tar.gz \
  /var/config/rest/iapps/irule-versioner/data/
```

After upgrading TMOS and reinstalling the Rülbased RPM, restore the data:

```bash
# Run on BIG-IP after TMOS upgrade + RPM reinstall
tar -xzf /shared/rulbased-data-backup-<date>.tar.gz -C /
bigstart restart restnoded
```

A one-click export/import workflow for this process is planned for Phase 7.

---

## Uninstalling

```bash
export BIGIP_PASS=<password>

# Find the package name
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/iapp/global-installed-packages \
  | python3 -c "import json,sys; [print(p['packageName']) for p in json.load(sys.stdin)['items'] if 'irule' in p['packageName'].lower()]"

# Uninstall
curl -sk -u admin:$BIGIP_PASS \
  -H "Content-Type: application/json" \
  -X POST https://<BIGIP>/mgmt/shared/iapp/package-management-tasks \
  -d '{"operation":"UNINSTALL","packageName":"irule-versioner-1.0.0-0001.noarch"}'
```

The data directory at `/var/config/rest/iapps/irule-versioner/data/` is NOT
deleted. Remove it manually only if you want to wipe all history:

```bash
ssh root@<BIGIP> "rm -rf /var/config/rest/iapps/irule-versioner/data"
```

---

## Re-baselining

```bash
# Wipe history and force full re-baseline on next start
ssh root@<BIGIP> "rm -rf /var/config/rest/iapps/irule-versioner/data/*"
ssh root@<BIGIP> "bigstart restart restnoded"
ssh root@<BIGIP> "tail -f /var/log/restnoded/restnoded.log | grep irule-versioner"
```

To add a single missing rule without wiping history:

```bash
curl -sk -u admin:$BIGIP_PASS \
  -X POST -H "Content-Type: application/json" \
  -d '{"message":"Manual baseline","author":"admin"}' \
  https://<BIGIP>/mgmt/shared/irule-versioner/rules/Common/my_rule/snapshot
```

---

## Development workflow

For fast iteration, use the phase patch scripts rather than rebuilding the RPM.
Each patch script is self-contained, writes files atomically, fixes ownership,
and restarts restnoded with a health check:

```bash
scp patch-phaseN.sh root@<bigip>:/tmp/
ssh root@<bigip> bash /tmp/patch-phaseN.sh
```

See PLANNING.md → "Iterative development — patch script approach" for the
canonical `write_file` pattern and rules for generating future patch scripts.
The ownership and temp-file rules documented there are mandatory — deviating
from them will cause restnoded to fail to load workers.

For direct file copy without a restart (e.g. `app.html` only):

```bash
scp presentation/app.html root@<bigip>:/var/config/rest/iapps/irule-versioner/presentation/
ssh root@<bigip> "chown --reference=/var/config/rest/iapps/irule-versioner/nodejs/lib/versionStore.js \
  /var/config/rest/iapps/irule-versioner/presentation/app.html"
# Hard-reload the browser — no restnoded restart needed for app.html changes
```

---

## REST API reference

All endpoints are under `/mgmt/shared/irule-versioner/`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rules` | List all iRules with status, hash, version count, drift flag |
| GET | `/rules/:p/:n/versions` | Version history for one rule |
| GET | `/rules/:p/:n/versions/:hash` | TCL content of a specific version |
| POST | `/rules/:p/:n/snapshot` | Manual snapshot `{ message, author }` |
| POST | `/rules/:p/:n/deploy` | Deploy a version `{ hash, reason, author }` → 202 `{ taskId }` |
| GET | `/rules/:p/:n/deploy/status/:taskId` | Poll async deploy task status |
| GET | `/rules/:p/:n/diff?from=:hash&to=:hash` | Side-by-side line diff |
| PUT | `/rules/:p/:n/retention` | Update retention policy `{ policy, max }` |
| GET | `/rules/audit` | Paginated audit log `?rule=&limit=&offset=` |
| GET | `/settings` | Read global settings |
| PUT | `/settings` | Update global settings |
| GET | `/settings/test-syslog` | Fire a test syslog entry to `/var/log/ltm` |
| GET | `/settings/test-webhook` | Fire a test POST to the configured webhook URL |
| GET | `/ui` | Serve full-page GUI |

---

## Syslog and webhook notifications

### Syslog

When `syslogEnabled` is `true` (default), Rülbased writes entries on every
deploy, rollback, and external-change event to **two destinations**:

**`/var/log/ltm`** — operational log, `local0.notice`, tag `rulbased`:
```
Apr 16 07:47:10 bigip01 notice rulbased[1415]: rulbased: [deploy] rule=/Common/my_rule to=e82f233 author=admin reason=CR-4421 adding HSTS header
```

**`/var/log/audit`** — security/compliance log, `local0.info`, `AUDIT` token,
matches native BIG-IP audit entry format for SIEM/auditor compatibility:
```
Apr 16 07:47:10 bigip01 info rulbased[1416]: AUDIT - user admin - RAW: rulbased: action=deploy rule=/Common/my_rule to=e82f233 reason=CR-4421 adding HSTS header
```

Test events (`GET /settings/test-syslog`) write to `/var/log/ltm` only — they
are not real configuration changes and do not belong in the audit log.

**Grep for entries:**
```bash
grep rulbased /var/log/ltm | tail -20
grep rulbased /var/log/audit | tail -20
```

**Test both destinations without triggering a deploy:**
```bash
curl -sk -u admin: \
  http://localhost:8100/mgmt/shared/irule-versioner/settings/test-syslog -w "\n"
# {"ok":true,"message":"Entries written — check: grep rulbased /var/log/ltm && grep rulbased /var/log/audit"}
```

### Webhook

When `webhookUrl` is set, Rülbased sends an HTTP/HTTPS POST to that URL on
every deploy and rollback event. Webhook on drift events is controlled
separately by `webhookOnDrift` (default `false`).

**Payload shape:**
```json
{
  "event": "deploy",
  "rule": "/Common/my_rule",
  "fromHash": "b2e1a09",
  "toHash": "e82f233",
  "author": "admin",
  "reason": "CR-4421 adding HSTS header",
  "timestamp": "2026-04-16T07:47:10.000Z",
  "device": "bigip01.example.com"
}
```

**`event` values:** `deploy` | `rollback` | `external-change-detected` | `test`

**HMAC signing:** If `webhookSecret` is set, the request includes an
`X-Hub-Signature-256` header — `sha256=<hmac>` computed over the raw JSON body,
matching the GitHub webhook signature format. Verify in your receiver:

```python
import hmac, hashlib
sig = 'sha256=' + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
assert hmac.compare_digest(sig, request.headers['X-Hub-Signature-256'])
```

**Retry behaviour:** Failed deliveries are retried up to 3 times with 5 s
backoff. If all attempts fail, a `webhook-failed` entry is written to the audit
log with the error message.

**Test webhook from CLI:**
```bash
curl -sk -u admin: \
  http://localhost:8100/mgmt/shared/irule-versioner/settings/test-webhook -w "\n"
# {"ok":true}  or  {"ok":false,"error":"No webhook URL configured"}
```

**Example: Slack incoming webhook**

Configure a Slack app with an incoming webhook URL, then in Rülbased Settings:
- Webhook URL: `https://hooks.slack.com/services/T.../B.../...`
- Webhook on drift events: on or off per preference

Rülbased sends raw JSON — to format it for Slack, put a small translation
function in front (AWS Lambda, a local nginx + Lua stub, etc.) or use a
Slack workflow that accepts raw JSON payloads.

---

## Version store layout

```
/var/config/rest/iapps/irule-versioner/data/
  Common/
    my_rule/
      manifest.json     ← version history + retention policy
      a3f9c12.tcl       ← TCL blob keyed by short SHA-1
      b2e1a09.tcl
  audit.jsonl           ← append-only audit log (JSON Lines)
  settings.json         ← persisted global settings
```

---

## Settings reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `dataDirectory` | string | `…/data` | Version store root — do not change after first install |
| `pollIntervalSeconds` | integer | `300` | External-change poll interval; `0` disables polling |
| `dashboardAuditLimit` | integer | `15` | Number of entries shown in the dashboard activity feed |
| `syslogEnabled` | boolean | `true` | Write to `/var/log/ltm` on deploy/rollback/drift via `local0.notice` |
| `webhookUrl` | string | `""` | HTTP/HTTPS POST target for event notifications; empty = disabled |
| `webhookSecret` | string | `""` | HMAC-SHA256 signing secret; when set, adds `X-Hub-Signature-256` header |
| `webhookOnDrift` | boolean | `false` | Also fire webhook on external-change events (default off to avoid noise) |
| `iruleLinks` | boolean | `true` | Click iRules events and namespace commands to open CloudDocs reference pages |
| `tclManPageLinks` | boolean | `true` | Click standard TCL commands to open tcl-lang.org 8.4 man pages |
| `debugMode` | boolean | `false` | Enable `[iRV]` browser console logging and verbose notifier logging |

---

## Running unit tests

```bash
node test/unit.js
# 16 tests, no framework, no BIG-IP required
```

---

## Key design decisions

**iControl REST for all reads and writes** — iRule content is read and written
via localhost:8100. Reads use `GET` with `?$select=apiAnonymous` for clean TCL
with no tmsh metadata. Writes use `PATCH { "apiAnonymous": content }`.

**localhost:8100 authentication** — `Authorization: Basic admin:` (empty
password) is accepted by restjavad without password validation on the localhost
channel. No credentials are stored anywhere in the extension.

**Content-addressed blob store** — Blobs are stored as `<7-char-sha1>.tcl`.
Identical content auto-deduplicates — saving unchanged content produces no new
blob or manifest entry.

**No npm dependencies** — Only Node.js built-ins (`fs`, `path`, `crypto`,
`child_process`, `http`). Compatible with Node.js 6.9.1 on TMOS 21.x.

**CodeMirror inlined** — The full CodeMirror bundle is inlined into `app.html`
as `<script>` and `<style>` blocks. restnoded's RestOperation pipeline
overwrites Content-Type for string bodies, making separate vendor file serving
unreliable.

**iRules overlay is stateless** — CodeMirror 5's `addOverlay` rejects
`startState`/`copyState` at runtime. The overlay uses `stream.string` and
`stream.start` lookbehind to determine namespace context without state.
