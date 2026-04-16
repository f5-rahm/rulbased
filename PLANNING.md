# Rülbased — Project Planning Document

This document captures all design decisions, data models, API contracts, GUI
specifications, and phase-by-phase deliverables for the Rülbased iApps LX
extension. It is intended to provide full context for continuing development
across sessions without needing to re-litigate decisions already made.

---

## Resuming this project

If starting a new session, paste this file (or upload it) and use a prompt
along the lines of:

> I am building an iApps LX extension for BIG-IP called "Rülbased".
> The attached PLANNING.md contains all spec decisions, data models, REST API
> definitions, GUI specifications, and the current implementation status.
> Phase 5 is complete. Please read the planning doc and help me continue with
> Phase 6 (import/export + upgrade hardiness).

Upload both this file and the phase source zip (`irule-versioner-phase5.zip`)
to give the new session full context.

---

## Iterative development — patch script approach

All phases from Phase 2 onward use self-contained shell patch scripts
(`patch-phaseN.sh`) for live iteration on a real BIG-IP without rebuilding
the RPM. This is the established pattern — do not deviate from it.

### How they are generated

Patch scripts are generated on the **build machine** by catting the actual
changed files directly into heredoc sections. This is critical — never embed
file content as Python strings or shell variables. The cat-into-heredoc
approach handles all encodings, special characters, and large files correctly.

```bash
OUTFILE="patch-phaseN.sh"
{
cat << 'SCRIPT_HEADER'
#!/usr/bin/env bash
set -euo pipefail
BASE="/var/config/rest/iapps/irule-versioner"
[ -d "$BASE" ] || { echo "ERROR: not found"; exit 1; }

write_file() {
  local dest="$1"
  local tmp; tmp=$(mktemp /tmp/.irv-patch-tmp.XXXXXX)
  cat > "$tmp"
  cp "$tmp" "$dest"
  chmod 420 "$dest"
  chown --reference="$BASE/nodejs/lib/versionStore.js" "$dest" 2>/dev/null || true
  rm -f "$tmp"
  echo "    wrote $dest"
}

echo "==> Writing nodejs/lib/someFile.js"
write_file "$BASE/nodejs/lib/someFile.js" << 'EOF_SOME_FILE'
SCRIPT_HEADER

cat /path/to/local/someFile.js

cat << 'SCRIPT_FOOTER'
EOF_SOME_FILE

echo "==> Restarting restnoded…"
bigstart restart restnoded

echo "==> Waiting for worker…"
CODE="000"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  CODE=$(curl -sk -o /dev/null -w "%{http_code}" -u "admin:" \
    "http://localhost:8100/mgmt/shared/irule-versioner/rules" 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then echo "    healthy after $((i*3))s"; break; fi
  echo "    …$((i*3))s (HTTP $CODE)"
done

if [ "$CODE" != "200" ]; then
  echo "==> Not healthy — last 20 lines of log:"
  tail -20 /var/log/restnoded/restnoded.log 2>/dev/null || true
fi
SCRIPT_FOOTER
} > "$OUTFILE"

chmod +x "$OUTFILE"
bash -n "$OUTFILE" && echo "syntax OK"
```

### Rules for write_file

- **Temp file goes to `/tmp/`**, never inside the target directory. restnoded
  scans the entire nodejs tree — a leftover temp file in `nodejs/lib/` from
  an interrupted run can break the directory scan on the next restart.
- **Use `cp` not `mv`** to write the final file. `cp` to an existing path
  preserves the destination inode's ownership. `mv` replaces the inode with
  the temp file's root ownership, making the file unreadable by restnoded
  (uid 198).
- **Always `chown --reference=versionStore.js`** after the `cp`. This corrects
  ownership even if a previous bad patch left the file root-owned. Use
  `versionStore.js` as the reference because it has never been patched and
  is known-good.
- **`chmod 420`** is decimal for octal `0644`. Never use `0o644` — Node 6
  on BIG-IP does not support ES6 octal literals and silently treats them as 0.

### During-phase iteration

While iterating within a phase — fixing bugs, adjusting behaviour, responding
to real-device test results — **share only the patch shell script** (`patch-phaseN.sh`
or `patch-phaseNb.sh` etc.). Do not repackage the full project zip until the
phase is complete and all on-device tests pass. The zip is the end-of-phase
deliverable; the patch script is the iteration tool.

```bash
scp patch-phaseN.sh root@<bigip>:/tmp/
ssh root@<bigip> bash /tmp/patch-phaseN.sh
```

### Verifying after a patch

If the health check returns 404 or workers are missing from the log, the first
thing to check is file ownership:

```bash
ssh root@<bigip> "ls -la /var/config/rest/iapps/irule-versioner/nodejs/lib/"
# All files should be owned by restnode (uid 198) or whatever user owns versionStore.js
# Any root-owned .js file will prevent that worker from loading
```

---

## Project overview

**Rülbased** is an iApps LX RPM package installed on BIG-IP that provides
version control for iRules. Operators can snapshot, diff, deploy, and rollback
iRules through a built-in GUI served directly from the BIG-IP management plane.
Versions are stored locally on the BIG-IP filesystem. A GitHub integration
(Phase 6) allows pushing and pulling iRules to/from a remote repository, with
support for both static iRules and per-device parameterised templates.

### Core technology decisions

- **iApps LX** (not iControl LX) — uses the block state machine, config
  processor lifecycle, and presentation layer
- **Hybrid read/write strategy** — iControl REST via localhost trusted channel
  for reads, tmsh for writes. Decided during Phase 1 implementation:
  - **Reads** (`listAllRules`, `getRuleContent`, `listPartitions`): use
    `GET http://localhost:8100/mgmt/tm/ltm/rule` via Node.js `http` module.
    restnoded running inside the BIG-IP management plane has implicit trust on
    the localhost:8100 channel — no credentials, no auth header, no tokens.
    The REST API returns `apiAnonymous` (clean TCL body, no tmsh metadata) and
    handles all partitions automatically, eliminating the need for a parser.
  - **Writes** (`deployRule`, `saveConfig`): keep tmsh `load sys config merge`
    + `save sys config` — the right tool for mutating config, battle-tested,
    explicit persistence guarantee.
- **No credentials stored or passed anywhere** — the localhost:8100 trusted
  channel requires no auth; tmsh runs as the process user (root under restnoded)
- **No npm dependencies** — Node.js built-ins only (`fs`, `path`, `crypto`,
  `child_process`, `http`) to avoid restnoded runtime compatibility issues

### Target environment

| Component | Version |
|-----------|---------|
| TMOS | 21.x |
| Node.js (restnoded) | 6.9.1 |
| TCL | 8.5.13 |

**Node.js 6.9.1 constraints** (ES2015/ES6 — partial support only):
- No `const`/`let` in production code — use `var` throughout
- No arrow functions `() => {}` — use `function() {}`
- No template literals — use string concatenation
- No `Object.assign`, `Promise`, `async`/`await`
- No `0o` octal literals — use decimal: `0o600`→`384`, `0o644`→`420`, `0o755`→`493`
- `fs.mkdir` does NOT support `{ recursive: true }` — falls back to
  `_mkdirpLegacy` which is already implemented in `versionStore.js`
- `Buffer.from()` IS available in Node 6.9.1 ✅ (added in 5.10)
- `JSON.parse` / `JSON.stringify` work normally ✅

**TCL 8.5.13 constraints** (relevant if tmsh scripting is used in future phases):
- No `try`/`finally` (use `catch` only)
- `dict` command available (added in 8.5)
- `lassign` available ✅
- String operations and `regexp` work normally ✅
- **Content-addressed blob store** — version blobs stored as `<7-char-sha1>.tcl`
  files; identical content deduplicates automatically
- **Local filesystem only** for version storage (no remote DB, no iControl REST
  writes for version data)

---

## Full spec decisions (all 20 questions)

| # | Question | Decision |
|---|----------|----------|
| 1 | Version storage | Local filesystem only |
| 2 | GitHub auth | Both PAT and GitHub App (OAuth) supported |
| 3 | Multi-device handling | System-aware for all BIG-IPs; GitHub supports both static iRules (same file for all devices) and per-device templates with `{{variable}}` substitution |
| 4 | Which iRules to manage | All iRules on the system |
| 5 | When to create a version | On any change — poll detects external changes, tool-driven deploys auto-snapshot |
| 6 | Retention policy | User-configurable per iRule |
| 7 | GUI layout | Master-detail split panel — iRule list on left (25%), detail on right (75%) |
| 8 | Diff viewer | Side-by-side (old left, new right) |
| 9 | Inline code editor | Yes — built-in TCL editor with syntax highlighting (CodeMirror) |
| 10 | Deploy/rollback flow | Two-step: stage → confirm dialog showing diff + mandatory typed reason; Confirm button disabled until reason is non-empty |
| 11 | Import/export | Both — tar.gz export and import of full local version store |
| 12 | Access control | None — anyone with BIG-IP admin access can do anything |
| 13 | iRule list organisation | Flat list by default; toggle to group by partition or by virtual server association |
| 14 | Version metadata | Git-style: short hash (7-char SHA-1) + commit message + author (BIG-IP username) + ISO 8601 timestamp |
| 15 | Notifications | In-GUI toast/banner + syslog integration + webhook HTTP POST (Slack, Teams, etc.) |
| 16 | GUI theme | Auto — detects BIG-IP TMUI light/dark theme via parent frame body class; MutationObserver for live switching |
| 17 | GUI access | Both — embedded summary widget inside TMUI + standalone full-page app in separate tab |
| 18 | i18n | English only |
| 19 | Change detection | Both — scheduled poll (configurable interval, default 300s) + auto-snapshot on tool-driven deploys |
| 20 | External change detection | Poll compares live tmsh content hash against stored latest hash; new version created with `source: "external-poll"` on drift |

---

## Data model

### Version manifest — per iRule

**Location:** `/var/config/rest/iapps/irule-versioner/data/<partition>/<ruleName>/manifest.json`

Rule names containing `/` are normalised to `_` for the directory name.

```json
{
  "partition": "Common",
  "name": "my_redirect_rule",
  "retention": {
    "policy": "unlimited",
    "max": null
  },
  "githubLink": {
    "type": "static",
    "repo": "myorg/bigip-irules",
    "path": "rules/my_redirect_rule.tcl",
    "branch": "main",
    "lastSyncHash": "a3f9c12",
    "lastSyncTimestamp": "2026-04-13T14:32:00Z",
    "remoteSha": "abc123def456..."
  },
  "versions": [
    {
      "hash": "a3f9c12",
      "timestamp": "2026-04-13T14:32:00Z",
      "author": "admin",
      "message": "Added HSTS header injection",
      "source": "tool-deploy",
      "blobFile": "a3f9c12.tcl"
    }
  ]
}
```

**`retention.policy` values:** `"unlimited"` | `"count"` | `"age"`
**`retention.max`:** integer (version count) or days (for age policy), null for unlimited
**`source` values:** `"baseline"` | `"manual"` | `"tool-deploy"` | `"pre-deploy"` | `"external-poll"` | `"github-pull"`
**`githubLink`:** optional — absent if rule has never been linked to GitHub
**`githubLink.type`:** `"static"` | `"template"`

### Version blob

**Location:** `/var/config/rest/iapps/irule-versioner/data/<partition>/<ruleName>/<hash>.tcl`

Contains the raw TCL body only — no `ltm rule /P/N { }` wrapper. The wrapper
is added by `tmsh.js` when constructing the staging file for deployment.

### Template iRule format (GitHub — Phase 5)

iRules stored in GitHub as templates use `{{VARIABLE_NAME}}` substitution:

```tcl
when HTTP_REQUEST {
  if { [HTTP::host] eq "{{TARGET_HOST}}" } {
    pool {{TARGET_POOL}}
  }
}
```

The manifest stores the variable map per device hostname:

```json
"githubLink": {
  "type": "template",
  "repo": "myorg/bigip-irules",
  "path": "templates/host_router.tcl.tpl",
  "branch": "main",
  "variables": {
    "bigip-prod-01.example.com": {
      "TARGET_HOST": "app.example.com",
      "TARGET_POOL": "pool_prod"
    },
    "bigip-prod-02.example.com": {
      "TARGET_HOST": "app.example.com",
      "TARGET_POOL": "pool_prod_b"
    }
  }
}
```

Variable substitution happens in the config processor before deployment.
Variable values are validated against an allowlist of safe characters
(alphanumeric, `.`, `-`, `_`, `/`) to prevent TCL injection.

### Audit log

**Location:** `/var/config/rest/iapps/irule-versioner/data/audit.jsonl`

Append-only JSON Lines format. One JSON object per line.

```json
{"ts":"2026-04-13T14:32:00Z","author":"admin","action":"deploy","rule":"/Common/my_rule","fromHash":"b2e1a09","toHash":"a3f9c12","reason":"CR-4421 — adding HSTS per security review"}
{"ts":"2026-04-13T15:10:00Z","author":"external","action":"external-change-detected","rule":"/Common/other_rule","fromHash":"c3d4e5f","toHash":"d9f2c44","reason":"Detected by scheduled poll"}
{"ts":"2026-04-13T15:30:00Z","author":"admin","action":"github-pull","rule":"/Common/my_rule","toHash":"e1f2a3b","reason":"Pulled from myorg/bigip-irules@main"}
```

**`action` values:** `"deploy"` | `"rollback"` | `"external-change-detected"` |
`"github-pull"` | `"github-push"` | `"snapshot"` | `"baseline"`

### Global settings

**Location:** `/var/config/rest/iapps/irule-versioner/data/settings.json`

```json
{
  "dataDirectory": "/var/config/rest/iapps/irule-versioner/data",
  "pollIntervalSeconds": 300,
  "syslogEnabled": true,
  "webhookUrl": "",
  "webhookSecret": "",
  "github": {
    "authMethod": "pat",
    "pat": "",
    "appId": "",
    "appPrivateKey": "",
    "appInstallationId": ""
  }
}
```

GitHub credentials (`pat`, `appPrivateKey`) are stored as encrypted iApps LX
block input properties and written to settings.json only in encrypted/masked
form. They are never returned in plain text via the REST API.

### Full filesystem layout

```
/var/config/rest/iapps/irule-versioner/
  nodejs/                         <- processor code (RPM-managed)
  presentation/                   <- GUI files (RPM-managed)
  manifest.json                   <- iApps LX package tag
  block_template.json             <- block schema
  data/                           <- version store (NOT RPM-managed, survives upgrades)
    audit.jsonl
    settings.json
    Common/
      my_rule/
        manifest.json
        a3f9c12.tcl
        b2e1a09.tcl
    MyPartition/
      other_rule/
        manifest.json
        c3d4e5f.tcl
```

---

## REST API — full surface (all phases)

All endpoints are under `/mgmt/shared/irule-versioner/`. Authentication uses
the existing BIG-IP admin session cookie — no separate credentials.

### Rules worker (`/rules`)

| Method | Path | Phase | Description |
|--------|------|-------|-------------|
| GET | `/rules` | 1 | List all iRules with status, latest hash, drift flag, version count |
| GET | `/rules/:partition/:name/versions` | 1 | Full version history for one iRule |
| GET | `/rules/:partition/:name/versions/:hash` | 1 | Fetch TCL content of a specific version |
| POST | `/rules/:partition/:name/snapshot` | 1 | Manual snapshot `{ message, author }` |
| POST | `/rules/:partition/:name/deploy` | 1 | Deploy a version `{ hash, reason, author }` |
| GET | `/rules/:partition/:name/diff?from=:hash&to=:hash` | 1 | Side-by-side diff payload |
| PUT | `/rules/:partition/:name/retention` | 2 | Update retention policy `{ policy, max }` |
| GET | `/audit` | 2 | Paginated audit log `?rule=&limit=&offset=` |
| POST | `/export` | 6 | Trigger tar.gz export of full version store |
| POST | `/import` | 6 | Import a tar.gz version store archive |

### Settings worker (`/settings`)

| Method | Path | Phase | Description |
|--------|------|-------|-------------|
| GET | `/settings` | 1 | Read all global settings (credentials masked) |
| PUT | `/settings` | 1 | Update global settings |

### GitHub worker (`/github`) — Phase 9 (optional)

| Method | Path | Phase | Description |
|--------|------|-------|-------------|
| GET | `/github/status` | 9 | Connection status, auth method, last sync time |
| POST | `/github/test` | 9 | Test GitHub connectivity and credentials |
| GET | `/github/browse?repo=:repo&path=:path&branch=:branch` | 9 | Browse repo contents (file picker in GUI) |
| POST | `/rules/:partition/:name/github/link` | 9 | Link rule to a GitHub file `{ repo, path, branch, type }` |
| DELETE | `/rules/:partition/:name/github/link` | 9 | Unlink rule from GitHub |
| POST | `/rules/:partition/:name/github/pull` | 9 | Pull from GitHub, render template if needed |
| POST | `/rules/:partition/:name/github/push` | 9 | Push current live version to GitHub |

### Response shapes

**GET /rules** response:
```json
{
  "items": [
    {
      "partition": "Common",
      "name": "my_rule",
      "fullPath": "/Common/my_rule",
      "versionCount": 12,
      "latestHash": "a3f9c12",
      "latestTimestamp": "2026-04-13T14:32:00Z",
      "latestMessage": "Added HSTS header injection",
      "latestAuthor": "admin",
      "drifted": false,
      "retention": { "policy": "unlimited", "max": null },
      "inVersionStore": true,
      "onSystem": true,
      "githubLinked": false
    }
  ]
}
```

**POST /rules/:p/:n/deploy** request body:
```json
{ "hash": "a3f9c12", "reason": "CR-4421 — rollback to last known good", "author": "admin" }
```

**POST /rules/:p/:n/deploy** response:
```json
{
  "deployed": "a3f9c12",
  "version": { "hash": "a3f9c12", "timestamp": "...", "author": "admin", "message": "...", "source": "tool-deploy" },
  "audit": { "ts": "...", "author": "admin", "action": "deploy", "rule": "/Common/my_rule", "toHash": "a3f9c12", "reason": "..." }
}
```

---

## GUI specification

### Embedded summary widget (`presentation/index.html`)

Shown inside BIG-IP TMUI at the iApps LX block presentation URL. Read-only.

- Three stat cards: total tracked / rules with drift / rules versioned
- List of 8 most recently changed rules: status badge, full path, short hash, relative timestamp
- Status badges: `DRIFT` (orange) / `OK` (green) / `NEW` (blue, not yet in store)
- "Open Full Manager ↗" button opens the full-page app in a new tab
- Auto-refreshes every 60 seconds
- Theme: auto-detects parent TMUI frame light/dark via `MutationObserver`

### Full-page application (`presentation/app.html`) — Phase 2+

Single HTML file, vanilla JS only (no framework). Communicates with the
config processor via `fetch()` calls to `/mgmt/shared/irule-versioner/`.

#### Overall layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: iRule Versioner  [device: bigip-01]  [settings gear]   │
├──────────────────┬──────────────────────────────────────────────┤
│                  │                                              │
│  iRule list      │  Detail panel (tabbed)                      │
│  (25% width)     │  (75% width)                                │
│                  │                                              │
│  [search box]    │  ┌─ Overview ─ History ─ GitHub ─ Audit ──┐ │
│  [group toggle]  │  │                                         │ │
│                  │  │  (tab content)                          │ │
│  /Common         │  │                                         │ │
│    my_rule  OK   │  │                                         │ │
│    other  DRIFT  │  └─────────────────────────────────────────┘ │
│  /MyPartition    │                                              │
│    app_rule  OK  │                                              │
│                  │                                              │
└──────────────────┴──────────────────────────────────────────────┘
```

#### Left panel — iRule list

- Search box filters by name in real time
- Group toggle: Flat (default) | By Partition | By Virtual Server
- Each row: status badge + full path + short hash + relative timestamp
- Selected rule highlighted; clicking loads the detail panel
- Drift badge animates to draw attention
- "Refresh" button re-polls `/rules`

#### Right panel — Overview tab

- Rule full path, partition, version count, retention policy (editable inline)
- Virtual server associations (read from tmsh)
- GitHub link status badge
- Current live TCL content in CodeMirror (read-only by default)
- "Edit" button unlocks the editor
- Saving from the editor triggers: auto-snapshot → two-step deploy flow

#### Right panel — History tab

- Chronological version list: hash pill + author + relative timestamp + message
- "current" badge on the version matching the live system hash
- "drift" badge if live hash matches no stored version
- Select two versions with checkboxes → "Compare" button activates
- Side-by-side diff viewer below the list (old = left, new = right)
  - Line numbers on both sides
  - Deleted lines highlighted red, inserted lines highlighted green
  - Equal lines shown in muted colour
  - Horizontal scroll per pane for long lines
- Each version row has a "Deploy this version" button
- Deploy flow:
  1. Click "Deploy this version"
  2. Modal opens showing side-by-side diff of selected version vs current live
  3. Mandatory text field: "Reason for change" (Confirm button disabled until non-empty)
  4. Click "Confirm Deploy"
  5. POST to `/rules/:p/:n/deploy` with `{ hash, reason, author }`
  6. Spinner while deploy runs (deploy is async — poll for task completion)
  7. Success: toast notification + history list refreshes + "current" badge moves
  8. Failure: error modal with tmsh error message

#### Right panel — GitHub tab (Phase 9 — optional)

- Link status: Linked / Unlinked / Diverged
- If unlinked: "Link to GitHub" flow with repo browser (file picker)
- If linked: repo path, branch, type (static/template), last sync timestamp
- For template type: variable map editor (key/value table per device hostname)
- "Pull from GitHub" button → renders template if needed → shows diff → confirm
- "Push to GitHub" button → shows diff vs last known remote → confirm + commit message
- Conflict state (local hash ≠ remote SHA): warning banner with "Force pull" / "Force push" options

#### Right panel — Audit tab

- Filtered to the currently selected iRule
- Table: timestamp | author | action | from hash | to hash | reason
- Actions colour-coded: deploy (blue), rollback (amber), external-change (orange), github (purple)
- Paginated, 25 entries per page

#### Settings page (gear icon in header)

- Poll interval (seconds, 0 = disabled)
- Syslog enabled toggle
- Webhook URL + optional webhook secret (HMAC-signed payload)
- GitHub auth method toggle: PAT / GitHub App
- PAT: single text field (masked, write-only after save)
- GitHub App: App ID, Installation ID, Private Key (PEM, masked)
- "Test GitHub connection" button

#### Notifications

Three parallel notification channels, all triggered by deploy/rollback/drift events:

1. **In-GUI toast** — appears bottom-right, 5s auto-dismiss, colour-coded by
   action type, stacks up to 3
2. **Syslog** — via `tmsh` `log local0.notice` call from the config processor;
   facility and severity configurable; message format:
   `irule-versioner: [action] /partition/name hash=<h> author=<a> reason=<r>`
3. **Webhook** — HTTP POST to configured URL; JSON body:
   ```json
   {
     "event": "deploy",
     "rule": "/Common/my_rule",
     "fromHash": "b2e1a09",
     "toHash": "a3f9c12",
     "author": "admin",
     "reason": "CR-4421",
     "timestamp": "2026-04-13T14:32:00Z",
     "device": "bigip-01.example.com"
   }
   ```
   If `webhookSecret` is set, an `X-Hub-Signature-256` header is added
   (HMAC-SHA256 of body, same format as GitHub webhooks).

#### Theme handling

On load, the GUI reads the BIG-IP TMUI parent frame's `document.body`
classList for `dark-mode`, `theme-dark`, or `data-theme="dark"` attributes
and applies a matching CSS variable set. A `MutationObserver` watches the
parent body for attribute changes and re-applies the theme without a page
reload. Falls back to light theme if running outside an iframe (e.g. direct
URL access).

#### CodeMirror integration (Phase 2)

- Bundle only: core + TCL mode + show-hint addon
- Target bundle size: < 200KB minified
- Ship bundled in `presentation/vendor/codemirror.min.js` and
  `presentation/vendor/codemirror.min.css`
- Do NOT load from CDN — cannot assume outbound internet from BIG-IP
  management plane
- TCL mode provides: keyword highlighting (`when`, `if`, `set`, `proc`),
  iRule event highlighting (`HTTP_REQUEST`, `CLIENT_ACCEPTED` etc.),
  bracket matching, basic auto-indent

---

## Phase deliverables

### Phase 1 — RPM scaffold + baseline snapshots ✅ COMPLETE (fully tested on real BIG-IP)

**Status:** Implemented, unit tested (16/16 passing), and validated on BIG-IP TMOS 14.x and 21.x.

Deliverables completed:
- Installable RPM skeleton (`manifest.json`, `block_template.json`)
- `configProcessor.js` — BINDING/BOUND/UNBINDING lifecycle
- `bigipClient.js` — iControl REST reads via localhost:8100 trusted channel (no credentials)
- `tmsh.js` — write operations only: deploy via merge+save; tmsh parser removed
- `versionStore.js` — init, baseline snapshot, save version, deduplication,
  get manifest, get version content, append audit, walk manifests
- `pollWorker.js` — configurable interval, single-flight lock
- `rulesWorker.js` — REST API: list, versions, version content, diff, snapshot, deploy
- `settingsWorker.js` — GET/PUT settings
- `settings.js`, `blockUtil.js`, `logger.js` — supporting modules
- `presentation/index.html` — embedded summary widget with theme detection
- `build/build-rpm.sh` — local rpmbuild, no credentials required
- `build/install-rpm.sh` — install on BIG-IP, password from `$BIGIP_PASS` env var
- `test/unit.js` — bigipClient + versionStore async tests (16 passing)

**Lessons learned from real-device testing (TMOS 14.x):**

- **iControl REST on localhost:8100 requires auth even from restnoded.** The
  "trusted channel" assumption was wrong — port 8100 returns 401 without
  credentials. Fix: send `Authorization: Basic admin:` (empty password). On
  localhost, restjavad validates the username but not the password, so no
  credential is stored or transmitted.

- **`onStart` signature must be exactly `function(success)` — single argument.**
  The framework matches handlers by `function.length`. Declaring
  `function(success, failure)` (length=2) causes the framework to skip calling
  it entirely with no error. Always use single-argument form.

- **`this.logger` must be used inside `onStart`, not the module-level logger.**
  The restnoded framework mixes `RestWorker` into worker instances. At `onStart`
  time, `this.logger` is available immediately; our custom `logger.js` module
  may not be fully initialised due to load ordering.

- **`isPassThrough = true` is required for sub-path routing.** restnoded does
  exact URI matching by default. A worker at `shared/irule-versioner/rules` only
  receives requests to that exact path. Setting `isPassThrough = true` enables
  prefix matching so all sub-paths (e.g. `/rules/Common/my_rule/versions`) route
  to the same worker.

- **`fs.mkdir` with `{ recursive: true }` throws `ENOENT` on older Node (not
  `ERR_INVALID_OPT_VALUE`).** The TMOS-embedded Node version ignores the
  `recursive` option and tries to create the leaf directory directly, which fails
  with ENOENT when parents don't exist. The `_mkdirp` fallback now triggers on
  both error codes.

- **`uri.query` is a pre-parsed object on this TMOS version, not a string.**
  Calling `.replace()` on it throws `queryString.replace is not a function`.
  The `_extractQuery` helper now checks `typeof q` and handles both forms.

- **tmsh `list ltm rule recursive` does not work non-interactively.** The
  `recursive` keyword is an interactive shell modifier. Non-interactive fix:
  call `tmsh list ltm rule` for /Common (always works), then `tmsh list auth
  partition` to find non-Common partitions and query each separately. Superseded
  by the switch to iControl REST reads.

- **tmsh output contains metadata fields that must be stripped from TCL content.**
  Fields like `verification-status`, `nodelete nowrite`, `definition-signature`,
  `app-service`, `description`, and `metadata { }` blocks appear inside the
  `ltm rule { }` block. Some appear before the TCL (preamble), some after
  (trailing). Superseded by the switch to iControl REST reads where `apiAnonymous`
  returns clean TCL with no metadata.

- **The iApps LX block `configProcessor.onPost` lifecycle is not the right place
  for baseline initialisation.** `onPost` only fires when a block instance is
  explicitly created via `POST /mgmt/shared/iapp/blocks`. Using `onStart` on the
  iControl LX worker instead fires automatically on every restnoded restart and
  requires no manual operator step.

- **`bigstart restart restnoded` is confirmed correct on TMOS 14.x.** ✅

**Remaining open items for Phase 3+:**
- Orphaned blob files (versions pruned by retention policy) not yet cleaned up —
  deferred to Phase 5.

---

### Phase 2 — Full-page GUI + history + deploy flow ✅ COMPLETE (fully tested on real BIG-IP TMOS 21.x)

**Status:** Implemented and validated on BIG-IP TMOS 21.x, Node.js 6.9.1.

Deliverables completed:
- `presentation/app.html` — full-page master-detail SPA served via `uiWorker.js`
- Left panel: searchable iRule list with flat/partition grouping toggle
- Right panel: Overview tab with CodeMirror TCL viewer (syntax highlighting)
- Right panel: History tab with version timeline, two-region split layout
- Side-by-side diff viewer (line-level, colour-coded, context-collapsed)
- History compare: select two versions with checkboxes, diff renders in-place
- Draggable resize handle between version list and diff regions
- Two-step deploy/rollback flow: diff modal + mandatory reason field
- Confirm button disabled until reason is non-empty
- PUT `/rules/:p/:n/retention` endpoint ✅
- GET `/rules/audit` endpoint with pagination and rule filter ✅
- Right panel: Audit tab (per-rule filtered view, paginated) ✅
- In-GUI toast notifications (stacks to 3, 5s auto-dismiss) ✅
- "Edit" button unlocking inline CodeMirror editor ✅
- Save & Deploy from editor: sends buffer content, deploys + snapshots atomically ✅
- CodeMirror inlined directly into `app.html` (no vendor/ requests) ✅
- Deploy endpoint async: returns 202 + taskId, GUI polls for completion ✅
- Per-rule deploy lock (in-memory Map) prevents concurrent deploys ✅
- `settings.js` `load()` wired into `onStart` — settings persist across restarts ✅
- Poll worker reads interval from persisted settings ✅
- `uiWorker.js` — new worker serving static files via restnoded ✅
- `build/bundle-codemirror.sh` — build-machine script for vendor bundle ✅
- `test/test-external-change.sh` — validates external change detection end-to-end ✅

**Lessons learned from real-device testing (TMOS 21.x):**

- **Deploy write path: use iControl REST PATCH, not tmsh.** `tmsh load sys config
  merge file` is not usable from the `restnoded` user (uid 198). The user cannot
  acquire `/var/run/config_lock` and tmsh exits 1 even after a successful load
  because it cannot write its history file to `~/.tmsh-history-root` (home is `//`).
  Fix: `PATCH https://localhost/mgmt/tm/ltm/rule/~P~N { "apiAnonymous": content }`.
  Same localhost:8100 trusted channel used for reads. No temp files, no child
  processes, no permission issues. `tmsh.js` retained for future syslog use
  (Phase 3) but is no longer in the deploy path. `bigipClient.js` now owns both
  reads and writes.

- **`0o600` is ES6 octal syntax — Node 6.9.1 silently treats it as `0`.** Any
  `fs.writeFile` call with `mode: 0o600` writes a file with mode 0 (unreadable).
  Use decimal `384` instead. Added to Node 6 constraints list.

- **`restOperation.setContentType()` exists but restnoded serialises string bodies
  as JSON regardless.** The pipeline overwrites Content-Type for string bodies.
  Workaround: inline static assets (CodeMirror JS+CSS) directly into `app.html`
  as `<script>` and `<style>` blocks. No vendor file requests needed.

- **`display:none` CSS cannot be overridden by class if an inline `style.display`
  exists.** JS must clear inline styles (`el.style.display = ''`) not set them to
  `'none'`, so CSS class rules retain control. Setting `style.display = 'none'`
  permanently blocks class-based show/hide.

- **Presentation files are NOT served by the iApps LX framework automatically.**
  The framework only serves presentation files when a block instance exists. For
  a standalone full-page app, add a `uiWorker.js` registered at
  `shared/irule-versioner/ui` with `isPassThrough = true` that reads files from
  `presentation/` using `fs.readFile` and calls `restOperation.setContentType()`.
  Access the GUI at `/mgmt/shared/irule-versioner/ui`.

- **`manifest.json` must be present in the install directory.** Without it the
  iApps LX template picker hangs when creating a block instance. The RPM spec
  must include it.

- **Poll worker is the only available external change detection mechanism.**
  BIG-IP exposes no mcpd change events or iRule modification webhooks to iApps
  LX workers. Both TMUI GUI edits and VS Code iRules extension edits (which use
  `load sys config merge`) write directly to mcpd and are visible via
  `GET /mgmt/tm/ltm/rule` on the next poll cycle. Detection latency is bounded
  by `pollIntervalSeconds`. Recommended default: 30s (negligible load, one
  lightweight REST call per interval).

- **Node.js constraints addendum — `0o` octal literals not supported in Node 6.**
  Add to the constraints list alongside `const`, `let`, arrow functions, and
  template literals: `0o600` → use `384`; `0o755` → use `493`; `0o644` → use `420`.

---

### Phase 3 — Enhanced editor: iRules syntax + click-to-docs ✅ COMPLETE

**Status:** Implemented and validated on BIG-IP TMOS 21.x.

Deliverables completed:
- Stateless CodeMirror overlay on top of the base TCL mode — iRules-aware tokenisation without replacing the base mode
- Events (`HTTP_REQUEST`, `CLIENT_ACCEPTED`, etc.) highlighted in F5 red (`#E4002B`) with dotted underline and pointer cursor
- Namespace prefixes and `::` separator highlighted in F5 red; subcommands highlighted in jade green (`#009639`)
- Standard TCL commands emitted as `cm-tcl-cmd` tokens — underlined in their natural colour when `tclManPageLinks` is on
- `$variable::...` constructs correctly excluded via `$` prefix guard in the overlay
- Vocabulary sourced directly from CloudDocs: ~130 events across all modules, ~75 namespace prefixes with complete command lists
- Click-to-docs: click any highlighted token in read-only or edit mode to open the reference page in a new tab
  - iRules events → `https://clouddocs.f5.com/api/irules/<EVENT>.html`
  - Namespace commands → `https://clouddocs.f5.com/api/irules/<NS>__<cmd>.html`
  - Standard TCL commands → `https://www.tcl-lang.org/man/tcl8.4/TclCmd/<cmd>.htm`
- Both link types independently togglable: `iruleLinks` (default true) and `tclManPageLinks` (default true)
- Underlines gated on CSS body classes (`irv-irule-links`, `irv-tcl-links`) toggled by `_applyEditorSettings()` — no editor reload needed when settings change
- `webhookSecret` added to `_defaults` (was missing, causing `settings.update()` to throw `Unknown setting` on any save that included a secret, silently breaking all settings saves)
- Settings loaded on page startup via `GET /settings` in `DOMContentLoaded` — all toggles active from first interaction without opening the settings modal
- Debug logging toggle (`debugMode` setting, default off) — gates `[iRV]` console output, itself persists correctly across hard refreshes

**Lessons learned:**

- **`addOverlay` rejects stateful overlays at runtime.** CM5 checks for `startState`/`copyState` on the overlay object and throws `"Overlays may not be stateful"` if present. Must use stateless overlays with `stream.string`/`stream.start` lookbehind for namespace context.

- **`cm.on('mousedown', handler)` is a no-op.** `mousedown` is not a CodeMirror editor event. Must use `document.addEventListener('mousedown', handler, true)` (capturing) with a `cm.getWrapperElement().contains(e.target)` guard.

- **`coordsChar` only supports `'page'`, `'local'`, and `'div'` modes.** Passing `'window'` falls into the wrong branch of the internal `Qn()` coordinate converter and maps every click to a garbage position. Use `e.pageX`/`e.pageY` with `'page'` mode.

- **`!important` + `span.` specificity required to beat the base TCL mode.** The base TCL mode's keyword list includes `http` (case-insensitive), colouring `HTTP` purple as a `cm-keyword`. The overlay's `cm-irule-kw` class must use `span.cm-irule-kw { color: … !important }` to win the cascade.

- **Overlay `stream.start` points to the start of the current token, not after it.** When matching `::`, `stream.start` is the position of the first `:`. The namespace prefix sits at `stream.string[nsStart..stream.start]`, not at `stream.string[nsStart..stream.start-2]`.

- **Browser caching stale `app.html`.** restnoded sends no cache headers. Added `<meta http-equiv="Cache-Control" content="no-store">` to `app.html` head to prevent stale loads during development.

- **Settings must be loaded on startup, not only when the modal opens.** `GET /settings` was only called inside `openSettings()`. Flags like `debugMode` and `iruleLinks` were `undefined` (falsy) until the user manually opened settings. Fixed by fetching settings in `DOMContentLoaded` before `loadRuleList()`.

- **Overlay token classes must be applied unconditionally; CSS body classes gate visual presentation.** The overlay runs synchronously during CM rendering and has no access to async settings state. Emitting `tcl-cmd` always and toggling a `body.irv-tcl-links` class allows settings changes to take effect immediately via CSS without re-initialising the overlay.

---

### Phase 4 — Dashboard + branding ✅ COMPLETE

**Status:** Implemented and validated on BIG-IP TMOS 21.x.

Deliverables completed:
- **Product renamed to Rülbased** — "Rül" in white, "based" in F5 blue
  (`#0072b0`) italic; applied in navbar (19px) and dashboard intro card (22px)
- **Dashboard homepage** shown on initial load and when header title is clicked
  - Intro card: two-sentence product description + six feature bullets in the
    same card, separated by a thin divider; version pill (`v1.0.0`)
  - System health grid: rules tracked, drifted, with history, not yet tracked
  - Recent activity feed: `GET /rules/audit?limit=N` — action badges, rule
    path, reason, author, relative timestamp; clicking a row navigates to
    that rule
  - Changelog panel: static entries for v1.0.0 through v0.1.0
- **SPA view model** — `S.view` property (`'dashboard'` | `'rule'`); clicking
  header title returns to dashboard from any rule-detail view
- **`dashboardAuditLimit` setting** (default 15) — persisted to `settings.json`,
  exposed in Settings modal under a new "Dashboard" section
- `loadRuleList()` refreshes dashboard health stats when `S.view === 'dashboard'`
- `selectRule()` hides dashboard before showing rule-detail chrome

**Lessons learned from real-device testing (TMOS 21.x):**

- **File ownership is the #1 patch failure mode.** restnoded (uid 198) cannot
  read files written as root. `cp` to an existing file preserves the
  destination inode's ownership — but if a previous bad patch already set
  the file to root-owned, `cp` perpetuates the problem indefinitely. Always
  `chown --reference=versionStore.js <dest>` after every write, and include
  an explicit repair loop that re-chowns all touched files unconditionally.

- **Never use `mktemp` inside directories restnoded scans.** A leftover
  `.patch-tmp.*` file in `nodejs/lib/` from an interrupted run causes restnoded
  to attempt loading it as a worker, aborting the directory scan. Always use
  `/tmp/` for temp files in patch scripts.

- **`write_file` canonical pattern** — documented in the "Iterative
  development" section at the top of this file. This is now the standard
  for all future patch scripts.

- **Health check must use `http://localhost:8100` with `-u "admin:"`**, not
  `https://localhost` with a manually constructed Authorization header.
  BIG-IP's `base64` does not support `-n`, encodes a trailing newline, and
  produces an invalid credential.

- **Dashboard data strategy** — health stats come from the already-loaded
  `S.rules` array (no extra XHR); activity feed is a single `GET /rules/audit`
  call on dashboard load.

---

### Phase 5 — Syslog + webhook notifications ✅ COMPLETE

**Status:** Implemented and validated on BIG-IP TMOS 21.x.

Deliverables completed:
- `lib/notifier.js` — new module; `emit()` fires syslog and/or webhook on
  deploy/rollback/drift events; `testSyslog()` and `testWebhook()` for
  diagnostic endpoints
- **Dual syslog destinations:**
  - `/var/log/ltm` — operational entry via `local0.notice`, tag `rulbased`,
    format `rulbased: [action] rule=... to=... author=... reason=...`
  - `/var/log/audit` — security/compliance entry via `local0.info` with `AUDIT`
    token in message body, format `AUDIT - user <author> - RAW: rulbased: action=...`
    Matches native BIG-IP audit entry format for SIEM/auditor compatibility.
    Only fires for `deploy`, `rollback`, `external-change-detected` — not `test`.
- Webhook HTTP/HTTPS POST with optional HMAC-SHA256 `X-Hub-Signature-256`
  header; 3 attempts with 5s async `setTimeout` backoff; total failure written
  to audit log as `webhook-failed` action
- `webhookOnDrift` setting (default `false`) — gates webhook independently on
  external-change events; syslog always fires on drift when `syslogEnabled`
- `GET /settings/test-syslog` — fires test entries to both `/var/log/ltm` and
  `/var/log/audit`; returns `{ ok, error? }` with stderr on failure
- `GET /settings/test-webhook` — fires a test POST to the configured URL;
  returns `{ ok, error? }`
- Settings panel additions: webhook-on-drift checkbox, Test Webhook button,
  hint text explaining drift gate behaviour
- Syslog tag rebranded from `irule-versioner` to `rulbased` (ASCII — umlaut
  not valid in syslog tag fields)

**Lessons learned from real-device testing (TMOS 21.x):**

- **`tmsh log` is not a valid tmsh subcommand.** Use
  `/usr/bin/logger -p <facility>.<severity> -t <tag> <message>` for syslog
  emission from restnoded workers. Pass the message as a separate argv element
  — no shell quoting issues regardless of content.

- **syslog-ng routing to `/var/log/audit` requires BOTH `facility(local0)` AND
  `message("AUDIT")`** — both conditions in `filter f_audit` must be satisfied.
  `local3` routes to `/var/log/asm` (ASM module log), not audit. The `AUDIT`
  token in the message body alone is not sufficient — the facility must also be
  `local0`. Confirmed by reading `/etc/syslog-ng/syslog-ng.conf` directly.

- **`/var/log/ltm` uses `local0.notice`; `/var/log/audit` uses `local0.info`.**
  Both are `local0` facility, routed by the message content. The `AUDIT` token
  gates the audit destination; the absence of `AUDIT` keeps the LTM entry out
  of `/var/log/audit`.

- **restnoded rejects bodyless POSTs at the framework pipeline level before
  `onPost` is called.** Trigger-style endpoints with no request body must use
  GET. This is the same class of issue as the two-argument `onStart` — the
  framework enforces the contract silently with no error message.

- **restnoded does not append a newline to JSON responses.** curl output runs
  directly into the shell prompt and can appear invisible. Always add `-w "\n"`
  when testing: `curl -sk -u admin: <url> -w "\n"`.

- **Syslog tag must be ASCII.** The product is branded "Rülbased" but the
  syslog tag is `rulbased` — syslog tag fields are process names and do not
  support non-ASCII characters. The umlaut lives in the GUI only.

- **The package directory name and URL path (`irule-versioner`) are deferred
  to Phase 8 (rename).** Changing these requires a full RPM rebuild, reinstall,
  and data directory migration. All feature phases (6, 7) will continue using
  the existing path; Phase 8 is a dedicated rename-and-rebrand flag day.

- **During-phase iteration: share only the patch script, not the full zip.**
  The full project zip is the end-of-phase deliverable. During bug-fix
  iterations within a phase, generate and share only the focused patch script
  (`patch-phaseNb.sh` etc.) to avoid regenerating large zips unnecessarily.

---

### Phase 6 — Import/export + upgrade hardiness (2 weeks)

**Background — BIG-IP upgrade behaviour:**
After a TMOS version upgrade, the entire `/var/config/rest/iapps/` directory
is wiped — both the RPM-managed code *and* the `data/` subdirectory containing
all version history. The RPM simply needs reinstalling, but the `data/`
directory is the irreplaceable part. Until Phase 6's import/export is
implemented, operators should back up `data/` to the `/shared/` partition
(which persists across upgrades) before any TMOS upgrade:

```bash
# Pre-upgrade backup (run on BIG-IP)
tar -czf /shared/rulbased-data-backup-$(date +%Y%m%d).tar.gz \
  /var/config/rest/iapps/irule-versioner/data/

# Post-upgrade restore (after reinstalling RPM)
tar -xzf /shared/rulbased-data-backup-<date>.tar.gz -C /
bigstart restart restnoded
```

This manual procedure is what Phase 6 will automate and surface in the GUI.

Deliverables:
- POST `/export` — streams a tar.gz of the full data directory
- POST `/import` — accepts a tar.gz, validates structure, merges or replaces
- Import conflict handling: if a rule already has versions, prompt user to
  merge (append imported versions) or replace (overwrite manifest)
- **Pre-upgrade backup workflow** in the settings page: one-click export that
  downloads `rulbased-data-<date>.tar.gz` to the browser; import to restore
  after reinstalling following a TMOS upgrade
- Orphaned blob cleanup: on manifest save, remove `.tcl` blobs in the rule
  directory that are not referenced by any version entry
- Data migration framework: `lib/migrations.js` — version-stamped migration
  functions run on startup if stored schema version < current schema version
- RPM `%post` improvements: detect TMOS version for correct restart command
- README updates for upgrade procedures

---

### Phase 7 — Package rename: irule-versioner → rulbased

**Background — why deferred:**
The package directory name (`irule-versioner`) and all worker URL paths
(`/mgmt/shared/irule-versioner/...`) are baked into the RPM spec and every
`WORKER_URI_PATH` constant. Changing them is a flag day — full RPM rebuild,
reinstall, and data directory migration. All feature phases (6) continue
using the existing paths. Phase 7 is a single dedicated rename-and-rebrand
operation performed after all features are complete and validated.

**Scope — everything that must change atomically:**

Code:
- `WORKER_URI_PATH` in `rulesWorker.js`, `settingsWorker.js`, `uiWorker.js`,
  `configProcessor.js` — change `shared/irule-versioner/...` to `shared/rulbased/...`
- `onStart` data directory hardcoded path in `rulesWorker.js`:
  `/var/config/rest/iapps/irule-versioner/data` → `/var/config/rest/iapps/rulbased/data`
- `versionStore.js` and any other module with the old path hardcoded
- All `BASE` references in build scripts and patch scripts

RPM:
- RPM `Name:` field in the spec: `irule-versioner` → `rulbased`
- RPM `%files` section paths
- Package install/uninstall curl commands in `install-rpm.sh`

Data migration (on-device, run once):
```bash
# 1. Stop restnoded
bigstart stop restnoded

# 2. Move the data directory to preserve all version history
mv /var/config/rest/iapps/irule-versioner/data \
   /var/config/rest/iapps/rulbased/data   # after RPM installs the new package

# Alternatively, if old RPM is still installed alongside new:
cp -a /var/config/rest/iapps/irule-versioner/data \
      /var/config/rest/iapps/rulbased/data

# 3. Install new RPM, start restnoded
bigstart start restnoded
```

`lib/migrations.js` (Phase 6) will include a startup check that detects the
old data path and offers a one-click migration in the settings page.

GUI and docs:
- All `irule-versioner` references in `app.html`, `index.html` (API base URL,
  any hardcoded paths)
- README — all URL examples, curl commands, file path references
- PLANNING.md — resuming section, file structure, all path references
- `block_template.json` if it contains the old name

**New URL after rename:**
```
https://<bigip>/mgmt/shared/rulbased/ui
```

**Grep to find all remaining references before cutting the rename patch:**
```bash
grep -r "irule-versioner" nodejs/ presentation/ build/ --include="*.js" --include="*.html" --include="*.sh" -l
```

| Risk | Mitigation |
|------|------------|
| restnoded Node.js version is old (Node 6 on TMOS 13/14) | Avoid ES6+ syntax in processor code; no arrow functions, no `const`/`let` in hot paths, no template literals in production code; test on Node 6 |
| `fs.mkdir` `{ recursive }` not available on Node 6 | Already mitigated: `_mkdirpLegacy` fallback implemented in `versionStore.js` |
| tmsh `save sys config` is slow on large configs (can take 10–30s) | Moot — deploy now uses iControl REST PATCH which commits synchronously and does not require save sys config |
| Poll worker stacking during failover | Already mitigated: single-flight `_running` boolean lock in `pollWorker.js` |
| Large iRule content exceeding REST response buffer | iControl REST returns full `apiAnonymous` content in a single JSON response; BIG-IP enforces a 32MB response limit which is far above any realistic iRule size |
| localhost:8100 trusted channel unavailable | Only occurs if restjavad is not running (system startup/failover). `bigipClient.js` surfaces a clear ECONNREFUSED error; the poll worker's single-flight lock prevents cascading failures |
| GitHub PAT stored insecurely | Store as encrypted iApps LX block input property; never return in plain text via GET; mask in settings UI (Phase 9 — optional) |
| Template variable injection | Sanitise variable values against `^[a-zA-Z0-9._\-/]+$` before substitution (Phase 9 — optional) |
| CodeMirror bundle size | Inlined directly into `app.html` as `<script>`/`<style>` blocks (~187KB). No vendor file requests. CDN not used. `bundle-codemirror.sh` available if separate vendor files are needed for RPM size reasons. |
| BIG-IP management plane has no outbound internet | GitHub integration (Phase 9 — optional) requires outbound HTTPS on port 443; document network requirement; all other features work fully offline |
| Concurrent deploys to the same iRule | Add per-rule deploy lock in Phase 2 (simple in-memory Map of `<fullPath> → boolean`) |

---

## File structure (complete)

```
irule-versioner/
├── PLANNING.md                    ← this file
├── README.md                      ← install and usage guide
├── manifest.json                  ← iApps LX tag: { "tags": ["IAPP"] }
├── block_template.json            ← block input/output schema
├── nodejs/
│   ├── index.js                   ← restnoded entry: exports all workers ✅
│   └── lib/
│       ├── configProcessor.js     ← block lifecycle: BINDING → BOUND ✅
│       ├── rulesWorker.js         ← REST: /rules (Phase 1+2) ✅
│       ├── settingsWorker.js      ← REST: /settings + /settings/test-* ✅
│       ├── uiWorker.js            ← REST: /ui static file server (Phase 2) ✅
│       ├── githubWorker.js        ← REST: /github (Phase 9 — optional)
│       ├── bigipClient.js         ← iControl REST reads+writes via localhost:8100 ✅
│       ├── notifier.js            ← syslog + webhook notifications (Phase 5) ✅
│       ├── tmsh.js                ← tmsh child process wrapper ✅
│       ├── versionStore.js        ← filesystem version store ✅
│       ├── pollWorker.js          ← scheduled change detection ✅
│       ├── githubClient.js        ← GitHub API v3 HTTP client (Phase 9 — optional)
│       ├── settings.js            ← in-memory settings + persistence ✅
│       ├── blockUtil.js           ← iApps LX state transition helpers ✅
│       ├── logger.js              ← restnoded logger wrapper ✅
│       └── migrations.js          ← schema migration framework (Phase 6)
├── presentation/
│   ├── index.html                 ← embedded summary widget (Phase 1) ✅
│   └── app.html                   ← full-page GUI, CodeMirror + iRules overlay inlined (Phase 2+3) ✅
├── build/
│   ├── build-rpm.sh               ← local rpmbuild, no credentials ✅
│   ├── install-rpm.sh             ← install on BIG-IP, $BIGIP_PASS env ✅
│   └── bundle-codemirror.sh       ← build-machine script to bundle CodeMirror vendor files ✅
└── test/
    ├── unit.js                    ← versionStore + bigipClient async tests (16 passing) ✅
    └── test-external-change.sh    ← end-to-end external change detection test ✅
```

Files marked ✅ are complete. All others are planned for the phase indicated.

---

## Decisions deferred / not yet made

- **Read/write path: iControl REST via localhost:8100** ✅ DECIDED (Phase 1+2)
  All reads and writes use `http`/`https` to `localhost:8100/mgmt/tm/ltm/rule`
  with `Authorization: Basic admin:` (empty password validated on localhost).
  Reads use `GET ?$select=apiAnonymous`. Writes use `PATCH { apiAnonymous }`.
  `tmsh.js` is retained for Phase 5 syslog calls but is no longer in the deploy
  path. `bigipClient.js` owns both reads and writes.

- **Async deploy task tracking:** ✅ DECIDED (Phase 2)
  In-memory Map in `rulesWorker.js` (`_tasks` object keyed by taskId).
  Tasks auto-evict after 1 hour. Per-rule deploy lock (`_deployLock`) prevents
  concurrent deploys. Task IDs are `task-<seq>-<timestamp>`.

- **Webhook payload signing algorithm:** ✅ DECIDED (Phase 5)
  HMAC-SHA256 (`X-Hub-Signature-256`) matching GitHub webhook format.
  Implemented in `notifier.js`.

- **Import conflict UI:** when importing a tar.gz that contains versions for
  rules that already have local history, the user needs to choose merge vs
  replace. The exact UI treatment (modal per-rule vs global choice) is
  deferred to Phase 6.

- **GitHub App private key storage:** PEM keys are multi-line and don't store
  cleanly in a single iApps LX block property. Options: (a) store as a single
  `\n`-escaped string; (b) write to a separate file in the data directory and
  store only the path in settings. Decision deferred to Phase 9 (optional).

---

### Phase 9 — GitHub integration (optional — scope and security TBD)

**Status: deferred.** This phase is held pending a clearer understanding of the
network security requirements and credential storage model. The full design
discussion is captured in the session notes from Phase 5 completion.

**Why deferred:**
GitHub integration requires outbound HTTPS (port 443) from the BIG-IP
management plane to `api.github.com`. Many BIG-IP management networks are
intentionally isolated with no outbound internet path. Additionally, secure
credential storage (PAT or GitHub App private key) on-device requires careful
design decisions that were not yet settled at the time Phase 6 work began.
All other Rülbased features work fully offline; GitHub is the only phase with
an external network dependency.

**Key design decisions still open (resolve before starting this phase):**

1. **Outbound network path** — direct to `api.github.com`, or via an HTTP CONNECT
   proxy? If proxy support is needed, add a `githubProxyUrl` setting.

2. **Auth method scope** — PAT-only first (simpler), or both PAT and GitHub App
   (RS256 JWT via Node.js `crypto` module, no `jsonwebtoken` npm dep) in one phase?

3. **Credential storage** — PAT and GitHub App private key stored in
   `settings.json` (write-only masked, never returned in GET responses). GitHub
   App PEM stored as `\n`-escaped string in `settings.json` (recommended) or as
   a separate `data/github-app.pem` file.

4. **Pull confirm flow** — mandatory reason field (same as deploy modal), or
   pre-populated from the GitHub commit message?

5. **Push commit message** — operator types it in GUI, or defaults to latest
   local version message?

6. **Repo browse depth** — flat one-level only, or recursive directory traversal
   (expensive on large repos)?

**Architecture decision (recorded for when this phase resumes):**
All GitHub API calls should be made server-side from restnoded (Option A), not
from the browser. This keeps credentials entirely server-side, enables
write-only PAT masking, and keeps GitHub App JWT generation (RS256) in Node.js
`crypto` where it belongs. The browser never sees a credential. This requires
outbound HTTPS from BIG-IP — document this as a network prerequisite.

**Planned deliverables (when resumed):**
- `lib/githubClient.js` — GitHub REST API v3 client (Node.js `https` built-in,
  no npm deps); modelled after the `notifier.js` HTTP pattern
- `lib/githubWorker.js` — restnoded worker at `shared/irule-versioner/github`
- PAT auth: `Authorization: Bearer <token>` header
- GitHub App auth: RS256 JWT generation via `crypto` module, installation access
  token exchange, token caching with expiry
- `GET /github/status`, `POST /github/test`, `GET /github/browse`
- `POST /rules/:p/:n/github/link`, `DELETE` unlink, `POST` pull, `POST` push
- Pull flow: fetch content (base64 decode), detect static vs template,
  render `{{variables}}`, diff → confirm → snapshot
- Push flow: base64 encode live content, PUT to GitHub Contents API with
  previous file SHA for conflict detection
- Conflict detection: stored `remoteSha` vs current GitHub SHA
- Template variable substitution with allowlist sanitisation
  (`^[a-zA-Z0-9._\-/]+$`)
- Per-device variable map editor in GitHub tab of GUI
- GitHub tab added to `app.html` detail panel
