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
- Inline editor: click Edit to modify a rule
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
- **Standard TCL commands** underlined in their default colour when TCL links are enabled
- **Click-to-docs**: click any highlighted token to open the reference page in a new tab
- All link types independently togglable in Settings → Editor

### Phase 4 — Dashboard + Rülbased rebrand
- **Dashboard homepage** — shown on initial load; click the header title to return
- **System health grid** — rules tracked, drifted, new (untracked), orphaned
- **Recent activity feed** — last N audit entries across all rules with action badges
- **Changelog panel** — release history inlined in the dashboard
- **Rülbased branding** — "Rül" in white, "based" in F5 blue italic (`#0072b0`)

### Phase 5 — Syslog + webhook notifications
- **Syslog** on every deploy, rollback, and drift event — `/var/log/ltm` and
  `/var/log/audit`; tag `rulbased`
- **Webhook HTTP/HTTPS POST** with structured JSON payload and optional
  HMAC-SHA256 `X-Hub-Signature-256` signing (matches GitHub webhook format)
- **Retry logic** — 3 attempts with 5 s async backoff
- **Test endpoints** — `GET /settings/test-syslog` and `GET /settings/test-webhook`

### Phase 6 — Import/export, upgrade hardiness, and GUI enhancements
- **Backup & Restore** — one-click export downloads full version history as
  `.tar.gz`; import with hash-level conflict analysis (merge or replace per rule)
- **Create iRule** — write new iRules directly in the built-in editor with
  syntax error feedback inline; TCL errors shown below the editor alongside code
- **Inline deploy panel** — reason field and error display slide in below the
  editor; no modal overlay; Ctrl+Enter to deploy
- **TCL error display** — iControl REST error prefix stripped; multiple errors
  split onto separate lines; "incomplete command" translated to human-readable
  explanation
- **Orphaned rules** — ORPHAN badge (F5 red) for rules with history but no
  live BIG-IP object; Orphaned counter in dashboard health grid
- **Acknowledge workflow** — new rules show NEW badge until explicitly
  acknowledged; auto-acknowledges on first deploy from the create workflow
- **Remove from store** — delete version history for a rule without affecting
  the live iRule on the BIG-IP
- **Dashboard health** — four stats (Tracked, Drifted, New, Orphaned) with
  inline tooltips; New = on-system untracked + unacknowledged
- **Schema migration framework** (`migrations.js`) — version-stamped startup
  migrations; v0→v1 orphaned blob sweep
- **On-device backup directory** — backups saved to `/shared/rulbased-backups`
  (hardcoded; survives TMOS upgrades); RPM `%post` must create and chown to uid 198

---

## Requirements

| Component | Version |
|-----------|---------|
| BIG-IP TMOS | 13.0 or later (tested on 14.x and 21.x) |
| Node.js (restnoded) | 6.x (embedded in TMOS — no install needed) |
| rpmbuild (build machine only) | Any recent version |
| curl (build machine only) | Any recent version |

The BIG-IP user account used for install must have the **Administrator** role.

The directory `/shared/rulbased-backups` must exist and be owned by uid 198
(restnoded). This is handled by the RPM `%post` scriptlet in Phase 7. Until
then, create it manually:

```bash
mkdir -p /shared/rulbased-backups
chown 198:498 /shared/rulbased-backups
```

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
│       ├── migrations.js        ← schema migration framework (Phase 6)
│       ├── notifier.js          ← syslog + webhook notifications
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
chmod +x build/build-rpm.sh
./build/build-rpm.sh 1.2.0 0001
# Output: build/dist/irule-versioner-1.2.0-0001.noarch.rpm
```

---

## Installing

```bash
export BIGIP_PASS=<password>
chmod +x build/install-rpm.sh
./build/install-rpm.sh <host> admin build/dist/irule-versioner-1.2.0-0001.noarch.rpm
```

**After install, create the backup directory:**
```bash
ssh root@<bigip> "mkdir -p /shared/rulbased-backups && chown 198:498 /shared/rulbased-backups"
```

**Accessing the GUI:**
```
https://<bigip>/mgmt/shared/irule-versioner/ui
```

---

## Verifying the install

```bash
# All 4 workers should appear
ssh root@<BIGIP> "grep 'has started' /var/log/restnoded/restnoded.log | grep irule-versioner"

# Rules list
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/irule-versioner/rules \
  | python3 -m json.tool
```

---

## Upgrading

### Upgrading Rülbased (same TMOS version)

```bash
export BIGIP_PASS=<password>
./build/install-rpm.sh <host> admin build/dist/irule-versioner-1.2.0-0001.noarch.rpm
```

### Before a TMOS version upgrade

Use the GUI Backup button (toolbar → Backup) to download a `.tar.gz` of your
full version history before upgrading TMOS. After upgrading and reinstalling
the RPM, use the Restore button in the same modal to import your history back.

Alternatively, from the command line:

```bash
# Pre-upgrade backup
tar -czf /shared/rulbased-data-backup-$(date +%Y%m%d).tar.gz \
  /var/config/rest/iapps/irule-versioner/data/

# Post-upgrade restore (after TMOS upgrade + RPM reinstall)
tar -xzf /shared/rulbased-data-backup-<date>.tar.gz -C /
bigstart restart restnoded
```

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
  -d '{"operation":"UNINSTALL","packageName":"irule-versioner-1.2.0-0001.noarch"}'
```

The data directory is NOT deleted on uninstall.

---

## Re-baselining

```bash
ssh root@<BIGIP> "rm -rf /var/config/rest/iapps/irule-versioner/data/*"
ssh root@<BIGIP> "bigstart restart restnoded"
```

---

## Development workflow

```bash
scp patch-phaseN.sh root@<bigip>:/tmp/
ssh root@<bigip> bash /tmp/patch-phaseN.sh
```

See PLANNING.md → "Iterative development" for the canonical `write_file`
pattern and mandatory ownership rules.

---

## REST API reference

All endpoints are under `/mgmt/shared/irule-versioner/`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rules` | List all iRules with status, hash, version count, drift flag, acknowledged |
| GET | `/rules/:p/:n/versions` | Version history for one rule |
| GET | `/rules/:p/:n/versions/:hash` | TCL content of a specific version |
| POST | `/rules/:p/:n/snapshot` | Snapshot + deploy `{ content, message, author }` or `{ message, author }` |
| POST | `/rules/:p/:n/deploy` | Deploy a stored version `{ hash, reason, author }` → 202 `{ taskId }` |
| GET | `/rules/:p/:n/deploy/status/:taskId` | Poll async deploy task status |
| GET | `/rules/:p/:n/diff?from=:hash&to=:hash` | Side-by-side line diff |
| PUT | `/rules/:p/:n/retention` | Update retention policy `{ policy, max }` |
| PUT | `/rules/:p/:n/acknowledge` | Mark rule as acknowledged (clears NEW badge) |
| DELETE | `/rules/:p/:n` | Remove rule from version store (does not affect live iRule) |
| GET | `/rules/audit` | Paginated audit log `?rule=&limit=&offset=` |
| POST | `/rules/export` | Export full version store as base64 tar.gz |
| POST | `/rules/import` | Import tar.gz archive `{ data: base64, conflictMode: 'merge'|'replace' }` |
| POST | `/rules/import/check` | Analyse archive without importing `{ data: base64 }` |
| GET | `/settings` | Read global settings |
| PUT | `/settings` | Update global settings |
| GET | `/settings/test-syslog` | Fire test syslog entries |
| GET | `/settings/test-webhook` | Fire test webhook POST |
| GET | `/ui` | Serve full-page GUI |

---

## Syslog and webhook notifications

See Phase 5 section above — behaviour unchanged.

---

## Version store layout

```
/var/config/rest/iapps/irule-versioner/data/
  Common/
    my_rule/
      manifest.json     ← version history + retention policy + acknowledged flag
      a3f9c12.tcl       ← TCL blob keyed by short SHA-1
      b2e1a09.tcl
  audit.jsonl           ← append-only audit log (JSON Lines)
  settings.json         ← persisted global settings
```

The `manifest.json` now includes an `acknowledged` field (boolean). Manifests
created before Phase 6 without this field are treated as `acknowledged: true`.

---

## Settings reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `dataDirectory` | string | `…/data` | Version store root |
| `pollIntervalSeconds` | integer | `300` | Poll interval; `0` disables |
| `dashboardAuditLimit` | integer | `15` | Dashboard activity feed entries |
| `syslogEnabled` | boolean | `true` | Syslog on deploy/rollback/drift |
| `webhookUrl` | string | `""` | Webhook POST target |
| `webhookSecret` | string | `""` | HMAC-SHA256 signing secret |
| `webhookOnDrift` | boolean | `false` | Webhook on drift events |
| `iruleLinks` | boolean | `true` | Click-to-docs for iRules events |
| `tclManPageLinks` | boolean | `true` | Click-to-docs for TCL commands |
| `debugMode` | boolean | `false` | Browser console logging |
| `schemaVersion` | integer | `0` | Internal — managed by migrations.js |

---

## Running unit tests

```bash
node test/unit.js
# 16 tests, no framework, no BIG-IP required
```

---

## Key design decisions

**iControl REST for all reads and writes** — Reads use `GET ?$select=apiAnonymous`.
Writes use `PATCH { "apiAnonymous": content }`. For new rules (404 on PATCH),
falls back to `POST /mgmt/tm/ltm/rule`.

**Deploy errors use HTTP 200 with `{ ok: false, error }`** — restnoded intercepts
and transforms non-2xx responses before they reach the browser, making the body
unreliable. All errors that need to surface a message in the GUI return 200 with
`ok: false`.

**localhost:8100 authentication** — `Authorization: Basic admin:` (empty password).

**Content-addressed blob store** — `<7-char-sha1>.tcl`. Identical content
auto-deduplicates.

**No npm dependencies** — Node.js built-ins only. Node 6.9.1 compatible.

**CodeMirror inlined** — Full bundle inlined into `app.html`.

**TCL syntax validation** — iControl REST validates TCL when `apiAnonymous` is
submitted. Errors returned as 4xx with the TCL error message. No pre-validation
endpoint exists; "incomplete command" indicates an unclosed `{` block.
