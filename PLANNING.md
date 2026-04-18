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
> Phase 7 is complete (package rename irule-versioner → rulbased, validated
> on BIG-IP TMOS 21.x). The next phase is Phase 8: five UX improvements
> from early reviewer feedback — acknowledge-all button, hide F5 system
> iRules (`_sys_*`), Versions tab (deduplicated by content hash), dark mode
> (three-way Light/Dark/Auto), and a small set of polish items. Phase 9
> is HA awareness (hybrid push-on-write + periodic reconciliation, modeled
> on AS3's approach), and Phase 10 is final code review / security audit /
> optimization. Please read the planning doc and help me continue with
> Phase 8.

Upload both this file and the latest phase source zip
(`rulbased-phase7-final.zip`) to give the new session full context.

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
BASE="/var/config/rest/iapps/rulbased"
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
    "http://localhost:8100/mgmt/shared/rulbased/rules" 2>/dev/null || echo "000")
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
ssh root@<bigip> "ls -la /var/config/rest/iapps/rulbased/nodejs/lib/"
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

**Location:** `/var/config/rest/iapps/rulbased/data/<partition>/<ruleName>/manifest.json`

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

**Location:** `/var/config/rest/iapps/rulbased/data/<partition>/<ruleName>/<hash>.tcl`

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

**Location:** `/var/config/rest/iapps/rulbased/data/audit.jsonl`

Append-only JSON Lines format. One JSON object per line.

```json
{"ts":"2026-04-13T14:32:00Z","author":"admin","action":"deploy","rule":"/Common/my_rule","fromHash":"b2e1a09","toHash":"a3f9c12","reason":"CR-4421 — adding HSTS per security review"}
{"ts":"2026-04-13T15:10:00Z","author":"external","action":"external-change-detected","rule":"/Common/other_rule","fromHash":"c3d4e5f","toHash":"d9f2c44","reason":"Detected by scheduled poll"}
{"ts":"2026-04-13T15:30:00Z","author":"admin","action":"github-pull","rule":"/Common/my_rule","toHash":"e1f2a3b","reason":"Pulled from myorg/bigip-irules@main"}
```

**`action` values:** `"deploy"` | `"rollback"` | `"external-change-detected"` |
`"github-pull"` | `"github-push"` | `"snapshot"` | `"baseline"`

### Global settings

**Location:** `/var/config/rest/iapps/rulbased/data/settings.json`

```json
{
  "dataDirectory": "/var/config/rest/iapps/rulbased/data",
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
/var/config/rest/iapps/rulbased/
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

All endpoints are under `/mgmt/shared/rulbased/`. Authentication uses
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

### GitHub worker (`/github`) — Phase 11 (optional)

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
config processor via `fetch()` calls to `/mgmt/shared/rulbased/`.

#### Overall layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: Rülbased         [device: bigip-01]  [settings gear]   │
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

#### Right panel — GitHub tab (Phase 11 — optional)

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
   `rulbased: [action] /partition/name hash=<h> author=<a> reason=<r>`
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


### Phase 6 — Import/export + upgrade hardiness + GUI enhancements ✅ COMPLETE

**Status:** Implemented and validated on BIG-IP TMOS 21.x. Phase 6 expanded
significantly beyond the original import/export scope to include a full GUI
overhaul with iRule creation, inline editing, and operator workflow improvements.

**Deliverables completed:**

*Backend (Node.js):*
- `lib/migrations.js` — schema migration framework; v0→v1 orphaned blob sweep;
  `acknowledged` field cleanup; `CURRENT_SCHEMA_VERSION=1`
- `versionStore.js` — `_newManifest` sets `acknowledged: false` on new rules;
  `listRules` surfaces `acknowledged` flag (existing manifests without field
  treated as `true`); `acknowledgeRule()`; `exportArchive()`; `importArchive()`;
  `_analyseImport()` with hash-set comparison; `pruneOrphanedBlobs()` on retention trim
- `bigipClient.js` — `post()` helper; PATCH and POST error handlers extract clean
  message from iControl REST JSON error body and attach `.statusCode` to Error;
  `deployRule` uses `err.statusCode === 404` for create-via-POST fallback
- `rulesWorker.js` — `onDelete` handler; `DELETE /rules/:p/:n` removes store entry;
  `PUT /rules/:p/:n/acknowledge`; `POST /rules/export`; `POST /rules/import`;
  `POST /rules/import/check`; deploy errors return HTTP 200 `{ ok: false, error }`
  to bypass restnoded body interception; `/shared/rulbased-backups` hardcoded
  (not user-configurable); `RPM %post` must create and chown this directory
- `settings.js` — added `schemaVersion: 0` default; removed `backupDirectory`

*GUI (app.html):*
- **Dashboard health grid** — 4 stats: Tracked, Drifted, New, Orphaned; each
  with title tooltip; "Orphaned" counter in F5 red
- **ORPHAN badge** — F5 red (`#E4002B`) with white text, replaces DEL; for rules
  with history but no live BIG-IP object
- **NEW badge** — stays NEW until manually acknowledged; greyed-out Acknowledge
  button until baseline snapshot exists; auto-acknowledges on first deploy
- **Acknowledge button** — in Overview toolbar; clears NEW badge
- **Remove from store** — red Remove button in toolbar; confirm modal;
  `DELETE /rules/:p/:n`; does not affect live iRule
- **Backup & Restore modal** — export downloads `.tar.gz` to browser and saves
  copy to `/shared/rulbased-backups`; import with hash-level analysis (4
  scenarios: identical / archive-newer / local-newer / empty-local)
- **+ New iRule button** — right-aligned in left panel toolbar; modal with
  partition dropdown (populated from live rule list) and name field; opens
  editor with starter template; auto-acknowledges on first successful deploy
- **Inline deploy panel** — slides in below CodeMirror editor when editing;
  reason field + TCL error display alongside code; replaces Save & Deploy modal;
  Ctrl+Enter to deploy
- **Deploy error display** — `_formatTclError()` strips iControl REST error code
  prefix and `Rule [/P/N] error:` prefix; splits multiple errors onto separate
  lines; "incomplete command" translated to human-readable explanation
- **Intro card and changelog** — updated through v1.2.0; feature bullets include
  create/edit, syslog/webhook, backup/restore
- `DELETE` HTTP helper in GUI uses XHR (`req()`) not `fetch()` — fetch without
  `credentials: include` doesn't send BIG-IP session cookie
- `loadHistory` 404 → "No version history yet" message instead of error

---

### Phase 6 — Lessons learned

- **restnoded intercepts and transforms non-2xx HTTP responses before they reach
  the browser client.** The response body is not reliably delivered for 4xx/5xx
  responses. Use HTTP 200 with `{ ok: false, error: message }` for any error that
  needs to surface a meaningful message in the GUI. Reserve non-2xx codes only for
  cases where the error message doesn't need to reach the client (e.g. framework
  routing errors). This applies to 400, 422, 500 — all confirmed affected.

- **`fetch()` without `credentials: 'include'` does not send the BIG-IP session
  cookie.** All HTTP helpers in the GUI must use `XMLHttpRequest` via the existing
  `req()` function, including DELETE. `fetch()` appears to work for GET/POST in
  some contexts because the browser treats those differently from DELETE.

- **JS string literals containing `\n`, `\t`, or other escape sequences must not
  be written by Python into heredoc content.** Python `\n` in a string becomes a
  literal newline character in the output file. If that literal newline appears
  inside a JS single-quoted string, the JS parser sees an unterminated string
  literal and the file fails to parse entirely — restnoded cannot load the worker
  and every request returns 404. Use `String.fromCharCode(10)` for newline
  comparisons and `charCodeAt(N)` for character checks. This applies to any
  special character in a JS string literal generated by Python.

- **`apiAnonymousBase64` in iControl REST does NOT perform TCL syntax validation.**
  It stores the content without parsing, marks the rule as errored in TMUI, and
  returns HTTP 200. Use `apiAnonymous` (plain text) for deploy — validation errors
  are returned as HTTP 4xx with the TCL error message. `apiAnonymousBase64` is only
  useful for importing pre-validated content.

- **iControl REST `apiAnonymous` with an unclosed `{` returns "incomplete command"
  instead of enumerating all errors.** The TCL parser stops at the first incomplete
  command boundary (open brace at EOF). This is correct and unavoidable with plain
  `apiAnonymous` — there is no pre-validation endpoint. See Future Considerations
  for a proper multi-error approach. Current mitigation: translate "incomplete
  command" to a human-readable explanation in the GUI.

- **`node --check` is available on the build machine and must be used before
  generating any patch script that touches Node.js files.** A syntax error in
  any `.js` file prevents the worker from loading — every request returns 404
  with no indication of which file is broken. Add `node --check` to the patch
  build checklist.

- **iControl REST error code prefix format is `[0-9a-f]+:[0-9]+:`** (e.g.
  `01070151:3:`). Strip this before displaying to operators. Also strip the
  `Rule [/P/N] error:` wrapper. The useful content starts after both prefixes.
  Multiple errors in a single message are separated by `]/path:line:` — split
  on `]` followed by `/word/word:digit` to display each on its own line.

- **The `write_file` helper uses `cat > "$tmp"` which reads from stdin to EOF.**
  Between file sections in a multi-file patch script, the sentinel token (e.g.
  `EOF_BIGIP`) must appear on a line by itself with no leading/trailing whitespace.
  A sentinel collision (the token appearing inside a source file) silently
  truncates the file. Always check all source files for collision before building
  a patch. Use exact-line matching: `grep -Fxc 'SENTINEL' file` (not `-c` alone
  which counts partial matches).

---

### Future considerations — complete TCL error reporting

**Problem:** When an iRule has an unclosed `{` brace, iControl REST's TCL parser
stops at the first incomplete-command boundary and returns only `incomplete command`
rather than enumerating all syntax errors (missing quotes, unknown events, etc.).
TMUI gets richer error output because it may submit content differently or because
the BIG-IP's TMUI-side validation path wraps content differently.

**Options investigated:**
1. `apiAnonymousBase64` — stores without validation, marks rule errored. Rejected.
2. Trailing newline append — no effect on `incomplete command`. Rejected.
3. `tmsh verify sys config` — checks full config, not per-rule, requires config
   lock, not usable from restnoded uid 198. Rejected.

**Promising approaches for a future phase:**
- **Create-check-delete pattern:** POST the rule to a scratch partition or with a
  unique temp name, capture all errors from the response body, then immediately
  DELETE the rule. This is the only way to get iControl REST to report all errors
  on content with unclosed braces. Cost: two extra API calls, brief existence of
  a broken temp rule. Mitigation: use a dedicated `_rulbased_validate` rule name
  and always DELETE after, even on success. Consider a `POST /rules/validate`
  endpoint that wraps this pattern.
- **Client-side TCL brace counter:** Before submitting, count unmatched `{`/`}`
  pairs in the editor. If unbalanced, show a pre-flight warning: "Unbalanced
  braces detected — deploy may fail with incomplete command." This doesn't replace
  server-side validation but gives immediate feedback without an API call.

---

### Phase 7 — Package rename: irule-versioner → rulbased ✅ COMPLETE

**Status:** Implemented and validated on BIG-IP TMOS 21.x. Delivered as a
flag-day rebuild (no patch-script iteration) cut directly against a full
`build-rpm.sh` + `install-rpm.sh` + `post-install.sh` installation flow.
No data migration was performed — all existing data at the time of the
rename was test data; the old installation and its
`/var/config/rest/iapps/irule-versioner/` directory are left untouched
for the operator to clean up manually if desired. Real-device validation
uncovered the iApps LX scriptlet-bypass behaviour (see lessons learned
below), which was addressed mid-phase by adding a standalone
`post-install.sh` setup script shipped inside the RPM payload.

**Deliverables completed:**

Code:
- `WORKER_URI_PATH` renamed in `rulesWorker.js`, `settingsWorker.js`,
  `uiWorker.js`, `configProcessor.js` — now `shared/rulbased/{rules,settings,ui}`
  and `shared/iapp/processors/rulbased`
- Hardcoded data-directory path in `rulesWorker.onStart`, `configProcessor.onPost`,
  `configProcessor.onPut` — now `/var/config/rest/iapps/rulbased/data`
- `settings.js` default `dataDirectory` — renamed
- `uiWorker.PRESENTATION_DIR` — renamed
- `logger.js` `PREFIX` — renamed from `[irule-versioner]` to `[Rülbased]`
  (UTF-8 literal in source; restnoded writes logs UTF-8 without transformation)
- All inline `self.logger.info('[irule-versioner] ...')` strings in
  `rulesWorker.js` onStart and `uiWorker.js` — renamed to `[Rülbased]`. These
  use restnoded's per-worker `this.logger` (bypass our `logger.js` PREFIX) so
  they had to be updated explicitly
- URI prefix-stripping arrays in `rulesWorker.js` and `uiWorker.js` — renamed
- `configProcessor.js` `VERSION` constant — bumped to `2.0.0`
- `rulesWorker._exportData` rewritten: removed the broken
  `execFile('/bin/mkdir', ['-p', backupDir])` fallback (restnoded uid 198
  cannot create subdirs under `/shared/`), added `fs.statSync` pre-check,
  response now includes `devicePathSaved` (boolean) and `devicePathError`
  (string) so the GUI can show an actionable message when on-device copy
  is disabled. Browser download path unchanged

RPM:
- `build-rpm.sh`: `APP_NAME` → `rulbased`; default VERSION arg → `2.0.0`;
  `%post` logger tag and echo prefixes → `rulbased`; **`%files` list rebuilt**
  from actual `nodejs/lib/` contents (Phase 6 pre-existing bug: the list
  was missing `bigipClient.js`, `migrations.js`, `notifier.js`, `uiWorker.js`,
  and `app.html`); staging step now also includes `build/post-install.sh`
  so it ships inside the RPM payload
- `%post` scriptlet hardened: writes a diagnostic marker file at
  `/var/config/rest/iapps/rulbased-post-install.log` so execution can be
  verified. Note: **the iApps LX install pipeline does not execute
  scriptlets** (see lessons learned below); `%post` is retained for the
  edge case of manual `rpm -i` installation only
- New `build/post-install.sh` — standalone operator-run script, idempotent,
  creates `/shared/rulbased-backups` with uid:gid `198:498` / mode `0750`
  and the data directory. Shipped at
  `/var/config/rest/iapps/rulbased/build/post-install.sh` inside the RPM
- `install-rpm.sh`: example filename, verification curl URLs, log-tail grep
  (now `grep -i rulbased` so the ASCII syslog tag and UTF-8 log prefix
  both match); dropped the broken `/mgmt/toc | grep rulbased` check
  (known F5 platform issue, restjavad auth-routing bug, unrelated to us);
  password now prompts interactively via `read -rs` if `BIGIP_PASS` is
  not set in the environment; post-install block prints the
  `ssh root@<bigip> bash .../post-install.sh` command the operator must
  run
- `bundle-codemirror.sh`: comment prose

GUI:
- `presentation/index.html`: title, h1, version badge (`v1.0.0` → `v2.0.0`),
  `Open Full Manager` href (now `/mgmt/shared/rulbased/ui` — the canonical
  restnoded-served URL, not the static `/iapps/...` path), `BASE` constant
- `presentation/app.html`: file header comment, `API` constant,
  dashboard version pill (`v1.2.0` → `v2.0.0`), new `v2.0.0` changelog entry,
  backup modal text softened (removed the misleading "A copy is also saved
  on the device" claim that was only true when `post-install.sh` had run),
  `exportBackup()` handler updated to surface `devicePathSaved`/
  `devicePathError` from the REST response as a warning toast and an
  explicit status-line message

Docs:
- `README.md`: directory-tree label, build/install/uninstall examples with
  new RPM filenames, verification curl URLs, version-store filesystem layout,
  REST API base path sentence, pre-upgrade tar path, re-baseline rm path;
  removed the now-obsolete manual "create backup directory" step (the RPM
  `%post` does it)
- `PLANNING.md`: resuming section, patch-script canonical template,
  data-model locations, filesystem layout, REST API base path, GUI fetch
  base, ASCII mockup header, syslog example format, this completion entry

Test:
- `test/unit.js`: tmpDir prefix
- `test/test-external-change.sh`: API URL, settings URL hint, test iRule's
  internal `log local0.` message (using ASCII `Rulbased` because it emits
  through TCL → syslog, same reasoning as the syslog tag)

Block template:
- `block_template.json`: `name` (`irule_versioner` → `rulbased`), description,
  `dataDirectory` default, `configProcessorReference.link`,
  `presentationHtmlReference.link`

**Lessons learned:**

- **Grep for both the hyphenated package name AND the prose form.** The first
  few sweep passes grepped for `irule-versioner` only and missed 4 stragglers
  that used the prose form `iRule Versioner` (in `build/bundle-codemirror.sh`
  comments and a TCL log message in `test/test-external-change.sh`). A
  comprehensive sweep needs both: `grep -rn "irule-versioner\|iRule Versioner"`.

- **`[Rülbased]` (UTF-8) is safe as a log PREFIX, but keep the syslog tag ASCII.**
  The Node.js `logger.js` PREFIX is written to `/var/log/restnoded/restnoded.log`
  by the restnoded logger framework, which handles UTF-8 correctly. But the
  syslog tag passed to `/usr/bin/logger -t` must stay ASCII (`rulbased`) because
  syslog tag fields are process names and do not support non-ASCII. Same applies
  to any TCL `log local0.` messages that iRules emit.

- **Pre-existing Phase 6 `%files` bug.** The RPM spec's `%files` list had not
  been updated as new worker files were added in Phase 2/5/6 — `bigipClient.js`,
  `migrations.js`, `notifier.js`, `uiWorker.js`, and `app.html` were all
  missing. Phase 6 RPM installs would have failed at `rpmbuild` time (missing
  files in build root). This went unnoticed because Phase 2–6 iteration used
  the patch-script approach and never exercised the RPM build path. The rule
  going forward: any time a new file is added to `nodejs/lib/` or
  `presentation/`, also append it to `%files` in `build-rpm.sh` in the same
  change.

- **The widget `Open Full Manager` href was pointing at the static-file path
  (`/iapps/rulbased/presentation/app.html`), not the uiWorker-served path
  (`/mgmt/shared/rulbased/ui`).** Updated during this phase. The
  uiWorker-served path is the canonical one (Basic auth works cleanly, no
  Apache session assumptions) per the Phase 2 lessons.

- **Node `--check` all `.js` files before shipping.** Every .js file was
  re-validated after every edit. Part of the Phase 6 lessons rulebook,
  honoured throughout Phase 7.

- **The iApps LX install pipeline bypasses RPM scriptlets entirely.**
  Discovered during Phase 7 testing: an iApps LX RPM installed via
  `POST /mgmt/shared/iapp/package-management-tasks` is visible in
  `/mgmt/shared/iapp/global-installed-packages` but does NOT appear in the
  system RPM database. `rpm -q rulbased` returns `package rulbased is not
  installed` even though the package is fully functional. This confirms
  the install path is `rpm2cpio | cpio -i` (or equivalent payload
  extraction), not `rpm -i` or `rpm -U`, and means `%post`, `%pre`,
  `%preun`, `%postun`, and `%posttrans` scriptlets never execute for
  iApps LX packages. This is not documented by F5 but is consistent with
  how their own extensions (AS3, Declarative Onboarding, Telemetry
  Streaming) handle post-install setup: deferred initialization from
  within Node.js `onStart`, not from `%post`. Implication for Rülbased:
  we cannot rely on `%post` to create `/shared/rulbased-backups`.
  Solution shipped in Phase 7: a standalone `build/post-install.sh`
  script distributed inside the RPM payload at
  `/var/config/rest/iapps/rulbased/build/post-install.sh` that the
  operator runs via SSH as root after install. Idempotent, safe to re-run.
  The `%post` scriptlet is retained in the spec for the edge case of
  manual `rpm -i` installation, and now also writes a marker file at
  `/var/config/rest/iapps/rulbased-post-install.log` for future
  scriptlet-execution diagnostics.

- **restnoded cannot create subdirectories under `/shared/`.** restnoded
  runs as uid 198 (restnode:restnoded). `/shared/` is `root:root 0755` by
  default on BIG-IP. Any code path that tries to `mkdir /shared/...` from
  within a worker will fail with EACCES. The previous Phase 6 export code
  had an `execFile('/bin/mkdir', ['-p', backupDir])` fallback that looked
  defensive but was actually dead code — it could never succeed. Removed
  in Phase 7; export now pre-checks `fs.statSync` on the backup dir and
  returns `devicePathSaved: false` with a `devicePathError` message if
  it's missing. The GUI surfaces this as a yellow toast telling the
  operator to run `post-install.sh`.

- **BIG-IP's `jq` is compiled without Oniguruma regex.** Any jq command
  that uses `test()`, `match()`, `sub()`, `gsub()`, `capture()`,
  `splits()`, or `scan()` fails on-box with
  `jq was compiled without ONIGURUMA regex libary`. Confirmed by F5
  DevCentral documentation. Documentation examples that run on-device
  must use `contains()` and string equality, not regex. jq on the build
  machine (macOS Homebrew, apt, etc.) has regex support and works fine.

- **The `/mgmt/toc` endpoint is unreliable for install verification.**
  Hitting `/mgmt/toc` on some TMOS versions returns
  `URI path /mgmt/logmein.html not registered` instead of the expected
  REST catalog. This is a known F5 platform issue (restjavad auth-routing
  bug, tracked at F5 bug tracker ID 877145 and others), not related to
  our package. Removed from `install-rpm.sh` verification output in
  Phase 7; replaced with a direct `/mgmt/shared/rulbased/rules` check.

- **The two-step install (install-rpm.sh + post-install.sh) is a footgun.**
  Discovered in real-device testing: the operator ran `install-rpm.sh`,
  it succeeded, they tried to use the product, and exports silently
  failed because `post-install.sh` had not been run. The install script
  *printed* the post-install command but didn't run it. Two-step flows
  with "please remember to also run this" reminders get skipped in
  practice. Candidate improvements for Phase 8: have `install-rpm.sh`
  run `post-install.sh` automatically over SSH after the iControl REST
  install completes (with `--skip-post-install` opt-out), or prompt
  interactively. The current README and installer output now make the
  post-install step unmissable by restructuring as numbered steps 1–5
  rather than prose-with-callout.

- **Build-machine vs device script parity matters.** During testing the
  operator had an older version of the source on disk (phase7 or phase7b)
  but was trying to run `post-install.sh` — which didn't exist in those
  older zips and wouldn't be inside the RPM they built. The `post-install.sh`
  script lives in `build/` on the source tree and is staged into the RPM
  payload at `/var/config/rest/iapps/rulbased/build/post-install.sh` for
  operators to run on the BIG-IP via SSH. Both copies (Mac and BIG-IP)
  must be from the same phase. Rule going forward: when we ship a
  dependency between a Mac-side script and a BIG-IP-side file (or vice
  versa), make the RPM version number the source of truth and have the
  scripts print it at startup so mismatches are immediately visible.

---

### Phase 8 — UX improvements from early reviewer feedback ✅ COMPLETE (shipped as v2.1.0 across four patches: 8, 8b, 8c, 8d)

**Purpose:** Incorporate feedback from initial Rülbased users before
broader rollout. Five features, no architectural changes. Target release:
v2.1.0.

**Origin:** The operator shared Rülbased with a handful of early reviewers
after Phase 7 completed. These five items were the consolidated feedback.
Items 1–4 are pure feature work; HA sync (originally item 5 in the feedback
list) became its own phase (Phase 9) because the implementation scope is
substantial.

#### Feature 1 — Acknowledge all

**Problem:** On first install against a large BIG-IP deployment (hundreds
of pre-existing iRules), the operator is faced with acknowledging every
rule one-by-one before Rülbased starts tracking it meaningfully. This is a
terrible first-run experience and discourages adoption.

**Design:**
- Two UI placements: (a) the dashboard health grid's "New" stat becomes a
  clickable button ("Acknowledge all N new rules"); (b) a button in the
  left-panel toolbar alongside "+ New iRule" and "Backup" so it's always
  reachable from the rule list view
- New endpoint `POST /rules/acknowledge-all` that sets `acknowledged: true`
  on every rule manifest where `versions.length > 0` (matches the same gate
  as the per-rule Acknowledge button)
- Returns `{ acknowledged: N, skipped: M }` where skipped includes any
  rules that could not be acknowledged for reason (drifted, missing baseline)
- Confirmation dialog before execution: "Acknowledge N rules? This cannot
  be undone individually — each rule will still be tracked normally after
  this point, but the 'newly enrolled' marker will be cleared."
- Does NOT acknowledge drifted rules (`drifted: true`) — those genuinely
  need per-rule review. Post-run status message notes how many were skipped
  and why
- Audit log entry per bulk operation: `action=acknowledge-all
  count=<N> by=<user>` rather than N individual acknowledge entries, to
  keep the audit log readable

#### Feature 2 — Hide F5 system iRules

**Problem:** F5 ships a set of system iRules under the `_sys_` prefix
(for example `_sys_https_redirect`, `_sys_auth_krbdelegate`). These clutter
the rule list and aren't things operators typically version-control. They
should be hidden by default with an option to show them.

**Design:**
- Detection rule: rule name starts with `_sys_`. We do not attempt to
  inspect the tmsh `nodelete nowrite` flags (those live in tmsh metadata
  and are stripped from iControl REST's `apiAnonymous` field — the only
  field we currently read). Name-prefix detection is sufficient and matches
  F5's own convention
- New setting `hideSystemRules` (default `true`), configurable via Settings
  modal checkbox: "Hide F5 system iRules (names starting with `_sys_`)"
- Filter applied server-side in `rulesWorker.onGet` for `/rules` list
  response when the setting is enabled; filtered rules simply do not appear
  in the response. Dashboard stats and health counters exclude them too
- Muted status line at the bottom of the left panel: "N system iRules
  hidden" (when filter is active), which doubles as a hint that the setting
  exists
- The filter also prevents the poll worker from creating manifests for
  system rules, so `_sys_*.json` files do not accumulate in the data
  directory
- If a system rule is ever renamed to a non-`_sys_` name externally
  (unlikely), the next poll picks it up normally; if a user rule is renamed
  to start with `_sys_`, it becomes hidden (and we keep its manifest file
  for history preservation)

#### Feature 3 — Versions tab

**Problem:** The History tab shows a chronological timeline of every
snapshot, deploy, and rollback. This is good for audit but confusing when
an iRule has been rolled back and redeployed multiple times — the history
might show 20 entries but represent only 2 distinct content versions.
Operators find it hard to answer "how many actual configurations of this
iRule have ever existed?"

**Design:**
- New **Versions** tab alongside the existing History tab in the rule
  detail view
- Versions tab aggregates entries in the manifest's `versions[]` array by
  `blobFile` (the content-addressed hash). Each unique blob appears once,
  showing:
  - Short hash (first 7 chars of the blob filename)
  - First-introduced timestamp (earliest `versions[]` entry with this hash)
  - Last-deployed timestamp (most recent `versions[]` entry with this hash
    where `action` was `deploy` or `initial`)
  - Count of times this version has appeared in history
  - Most-recent commit message
  - Author (from most recent appearance)
- History tab behaviour unchanged — it remains the append-only timeline
  for audit purposes
- **Deploy button moves to Versions tab.** Deploying "a specific version"
  makes more sense in the deduplicated view — you deploy a content hash,
  not a point in time. Versions tab rows have a Deploy button
- **Diff button stays in History tab.** Diffing is inherently between two
  points in time ("what changed between these two events"), which is a
  History concept, not a Versions concept
- Pure GUI aggregation over existing `versions[]` data — no schema change,
  no data migration, no backend work beyond a small `/rules/:name/versions`
  endpoint that returns the deduplicated projection (alternatively, the GUI
  computes the projection client-side from the existing manifest response —
  preferred for simplicity)
- Default tab when opening a rule stays at **History** (no change in
  first-click behaviour)

#### Feature 4 — Dark mode

**Problem:** The GUI currently inherits a single light theme. Many
operators prefer dark mode, especially those who keep terminal windows and
Rülbased open side-by-side.

**Design:**
- Three-way setting `theme: "light" | "dark" | "auto"`, stored in
  `settings.json`, default `"auto"`
- `"auto"` uses `window.matchMedia('(prefers-color-scheme: dark)')` and
  listens for changes (so switching the OS theme updates Rülbased live)
- CSS is already variable-based (`:root { --bg: ... }`) from Phase 4's
  TMUI-theme-detection work — the dark mode is mostly adding a
  `[data-theme="dark"]` variable override block rather than a full rewrite
- Settings modal: new "Appearance" section with three radio buttons
  Light / Dark / Auto
- Dark-mode colour targets needing explicit attention (the existing
  TMUI-theme-detection work established defaults but they need a careful
  pass):
  - iRule syntax highlighting overlay (F5 red for events, jade green for
    namespaces) — ensure readable contrast in both themes
  - CodeMirror editor theme (has built-in themes; select `material-darker`
    for dark mode, default light otherwise)
  - Diff viewer background colours for added/removed/unchanged lines
  - Toast notifications (success/warn/error colour tones)
  - Modal overlays and focus rings
- Persistence: theme selection persists per-user via the settings REST
  endpoint. Since settings are device-local in Phase 8 (no HA sync yet),
  users on an HA pair may need to set theme on both devices; Phase 9's
  settings sync eliminates that

#### Integration notes

- All four features land in a single v2.1.0 release
- README gets a "What's new in 2.1" section at the top
- `app.html` gains a changelog entry `v2.1.0` listing all four features
- No migrations required — all features are pure GUI and settings
  additions that default to backward-compatible behaviour
- `configProcessor.VERSION` bumps to `2.1.0`
- RPM version bumps to `2.1.0-0001`

**Deliverables:**
- `/rules/acknowledge-all` endpoint + GUI button + confirmation dialog
- `hideSystemRules` setting + filter logic in `rulesWorker` + GUI checkbox
- Versions tab in rule detail view (client-side aggregation of existing
  manifest data)
- Deploy button moved from History to Versions; Diff stays in History
- Three-way theme toggle in Settings + CSS variable overrides for dark
  mode + CodeMirror theme switch
- README "What's new in 2.1" section
- `app.html` v2.1.0 changelog entry
- Version bumps in `configProcessor.VERSION` and build scripts
- Regression test: ensure the existing per-rule Acknowledge, the poll
  worker, the export/import round-trip, and the TMUI-theme-detection
  feature all still work

#### Phase 8 — As shipped (four patches, still v2.1.0)

Phase 8 landed in four successive patches against a live BIG-IP, with the
operator walking each one through a human reviewer between patches. Every
patch preserves the same `configProcessor.VERSION = 2.1.0` — these are all
point refinements within one release. All four patches are shipped as
`patch-phase8.sh`, `patch-phase8b.sh`, `patch-phase8c.sh`,
`patch-phase8d.sh`.

**Patch 8 — the four original features plus the one holdover from 8c:**
- `acknowledge-all` with bulk audit entry, drifted-rule skip, dual UI
  placement — shipped as planned
- `hideSystemRules` with the `_sys_*` + `nodelete nowrite` dual detection
  — shipped as planned. The original plan had name-prefix detection only,
  but the two-part detection was adopted to avoid filtering any user rule
  that happens to start with `_sys_`. The body marker is checked via
  `String.fromCharCode(10)` comparison because heredoc-embedded `\n`
  escapes break on transit through the patch script convention
- Versions tab with client-side blob-hash aggregation, Deploy button
  migration, Diff button staying on History — shipped as planned
- Three-way theme setting with OS + TMUI-frame detection — shipped as
  planned

**Patch 8b — reviewer feedback round 1:**
- CodeMirror dark-mode background was too dark (black `#0d1117`) against
  the left sidebar. Lightened the editor background to `#1f2937` (same
  family as the sidebar, slightly different tone for eye tracking between
  the panels)
- Theme radio buttons replaced with a dropdown in Settings — the radios
  read as heavier-weight than the one-of-three choice warranted
- History tab gained inline italic "info" rows for `acknowledge` and
  `remove-from-store` audit events, merged client-side from a parallel
  `GET /rules/audit` fetch with a 2-second dedupe window against
  content-change audit entries. Full audit tab stays intact — this is
  purely a readability enhancement of the per-rule History view
- Compare checkbox added on both History and Versions so the two-version
  selector can be driven from whichever tab is in view

**Patch 8c — reviewer feedback round 2 (dark mode legibility):**
- Dark mode was not applied on first page load when the persisted
  `theme=dark`. Root cause: `applyTheme()` ran at DOMContentLoaded before
  `GET /settings` returned, so `S.settings.theme` was undefined and
  `'auto'` branch fell through to light. Fix: a second `applyTheme()` call
  inside the settings-load callback after `S.settings` is populated
- Saving settings wiped TCL syntax highlighting entirely. Root cause:
  the original plan called for swapping CodeMirror to
  `cm-s-material-darker` in dark mode, but only `cm-s-default` CSS is
  bundled in `app.html`. Swapping the theme class flipped the class
  without any rules attached, collapsing TCL tokens to plain body text.
  Fix: abandon the CM theme swap entirely; keep `cm-s-default` always and
  apply a full dark palette via `body.iv-dark .cm-s-default .cm-*` CSS
  overrides with `!important`. Brand colors (`cm-irule-kw` = F5 red
  `#ff4d6d`, `cm-irule-cmd` = jade green `#00c94a`) are preserved across
  both themes
- Editor background unified with sidebar (`#1f2937`), gutter set to
  `#1a2332` (a shade darker than the editor body) for line-number
  separation without a hard border. Explicit `.CodeMirror-gutters` and
  `.CodeMirror-linenumber` rules under `body.iv-dark`

**Patch 8d — reviewer feedback round 3 (highlighting gaps + click UX):**
- Syntax highlighting for 93 top-level iRules commands from the CloudDocs
  *Commands* page. The phase 3 scrape captured `IRULE_EVENTS` and
  `IRULE_NS_CMDS` (namespace-prefixed) but missed the bare verbs —
  `when`, `log`, `call`, `pool`, `node`, `snat`, `virtual`, `reject`,
  `drop`, `forward`, `priority`, `timing`, `event`, `after`, `proc`,
  `return`, `persist`, and 76 others. Those rendered as plain text, or as
  TCL purple for the handful that collide with TCL keywords (`proc`,
  `return`, `after`, `class`). New `IRULE_TOP_CMDS` array + `_IRULE_TOP_SET`
  lookup wired into the overlay *before* the TCL check, so overlap names
  take the iRules color. Reuses the existing `cm-irule-kw` class (F5 red)
  — no new CSS. CloudDocs URL scheme for top-level commands follows the
  events convention: `https://clouddocs.f5.com/api/irules/<cmd>.html`
- Click-to-docs now requires Ctrl (or Cmd on macOS). Plain click was
  triggering document navigation on any highlighted token, which
  prevented placing the cursor inside a linked word. Click handler
  early-returns when no modifier is held, so CodeMirror's native
  mousedown places the cursor as usual. Matches the IDE-universal
  go-to-definition gesture. Tooltip help text updated

#### Phase 8 — Lessons learned

- **"Just ship a CodeMirror theme swap" didn't work.** The `cm-s-*` theme
  packages have their own CSS stylesheets that need to be bundled
  separately, and `app.html` only ships `cm-s-default`. Changing the
  theme class without the matching stylesheet silently breaks
  highlighting (the class flips but the selectors find no rules). For
  any future theme work, bundle the stylesheet alongside or override on
  top of `cm-s-default` — don't rely on unbundled themes
- **Settings-dependent UI needs a post-load hook.** The first-load dark
  mode bug was straightforward in retrospect: any initialization that
  depends on `S.settings` must run *after* the `/settings` fetch
  resolves, not just at DOMContentLoaded. Worth looking for other
  subtle instances of this pattern across the codebase in a future pass
- **CloudDocs "Commands" page is heterogeneous.** The page mixes
  top-level commands, namespace-scoped commands (`NS::cmd`), and
  "Operators". A clean scrape of just top-level commands requires
  filtering out entries containing `::` and the `Operators` doc-page
  category. This was done by hand for phase 8d; if the list ever needs
  refreshing, script it rather than re-listing by hand
- **`!important` is the right escape hatch for overlay palettes.**
  CodeMirror's base theme sets `color` on its token classes; overriding
  from a body-class selector requires `!important` to win against
  CM's style specificity. The alternative (tearing up CM's theme
  system) is far more invasive for no practical gain
- **Click handlers on document-capture need Ctrl/Cmd gating from day
  one.** The 8d Ctrl+click fix wasn't a new problem — it was latent from
  phase 3 when click-to-docs shipped. Any future "clickable word in an
  editor" feature should gate on modifier keys by default, because
  editor tokens need to be cursor-target-able
- **Patch-script iteration scales better than re-packaging the RPM.**
  Four patches in one afternoon against a live device would have been
  unworkable with full RPM rebuild/install/restart cycles. The
  patch-script convention (cat-into-heredoc, `cp` preserving inode
  ownership, sentinel uniqueness, JS `node --check` pre-flight, health
  check after `bigstart restart restnoded`) held up across all four
  patches without a regression. Zip repackage happens only at
  end-of-phase, not per-patch
- **Sentinel uniqueness matters.** Each patch uses a distinct heredoc
  sentinel (`EOF_APP_HTML` → `EOF_APP_HTML_8B` → `EOF_APP_HTML_8C` →
  `EOF_APP_HTML_8D`) so a downstream user who concatenates multiple
  patches into a single shell script doesn't get silent truncation from
  a sentinel collision
- **Simulated apply catches footgun bugs before the device does.**
  Every patch ran against a sandbox mirror at `/tmp/phase8X-sim/` with
  `bigstart` and `curl` stubbed, followed by a `diff -q` byte-compare
  against the working app.html. This caught two mistakes before they
  hit the real BIG-IP (a stray `$WORK` that wasn't expanded in the
  heredoc on patch 8; a tab→space mismatch in one of the insertion
  points on 8b) that would otherwise have tripped the health check and
  required a rollback

---

### Phase 9 — HA awareness for BIG-IP device clusters

**Purpose:** Rülbased on an HA pair (or larger DSC) should present a
unified view of version history, audit log, and settings across devices,
rather than each device being an isolated island. Target release: v2.2.0.

#### Phase 9 — Open decisions (resolve before coding starts)

The design below captures the intended architecture, but five scoping
decisions need operator input before the first patch lands. Each has
meaningful tradeoffs and shouldn't be assumed away.

1. **Phase 9 subdivision.** Phase 9 is substantially bigger than Phase 8
   (device discovery, new endpoints, cross-device HMAC, reconciliation
   loops, audit merge semantics). Break into 2–4 incremental patches
   (9, 9b, 9c…) so each can be live-tested on a real HA pair before the
   next lands. Propose a breakdown with reasoning; operator picks.

2. **HMAC shared secret — generation and storage.** The replication
   design assumes a shared secret stored on both devices. Practical
   options to walk through: manual operator setup (generate, paste into
   Settings on each device), auto-generated on first peer discovery
   (one device creates it, pushes to peer via authenticated iControl
   REST), tmsh data-group reuse (store as a hidden data-group that
   ConfigSync naturally replicates). Each has tradeoffs around operator
   burden, bootstrap ordering, and audit trail. Operator picks.

3. **Standalone detection cutoff.** Rülbased must be zero-overhead on
   standalone BIG-IPs. When and how do we check? Startup only, or
   periodic re-check to catch operators joining a device-group later?
   GUI behavior on standalone — hide HA UI entirely, or show disabled
   controls with an "HA features unavailable on standalone" hint?
   Operator picks.

4. **Audit log merge semantics.** Audit entries from multiple devices
   interleave with `device` attribution preserved. GUI render options:
   inline device tag on each row, filter chip to narrow to one device,
   grouping by device with a collapsed/expanded toggle, or some combo.
   Operator picks.

5. **Test strategy.** Unit tests don't naturally cover cross-device
   replication. Integration test options: simulated peer endpoints via
   loopback with a second restnoded port, two separate containers with
   mocked iControl, or real two-device HA lab time (slowest but most
   faithful). Operator picks based on available lab infrastructure.

**Problem statement:** BIG-IP's native ConfigSync operates at the folder
level on iControl objects and explicitly does NOT synchronize the
`/var/config/rest/iapps/` filesystem tree (F5 K21259300 lists "LX
Workspaces" on the not-synced list, and our data directory falls under
this category even though it's not an LX Workspace in the formal sense —
the same storage location, the same exclusion). This means:

- Rülbased's version store (`/var/config/rest/iapps/rulbased/data/`) is
  per-device
- A deploy on the active device creates a version entry the standby
  doesn't know about
- Failover leaves operators looking at a standby with no history of what
  the active device had been doing
- Settings changes made on one device don't reach the other
- The iRule content itself DOES sync (that's ConfigSync's proper job and
  works fine) — only Rülbased's *metadata about* the iRule doesn't sync

**Architecture decision (from Phase 9 planning):** Hybrid push-on-write +
periodic reconciliation, modeled on how AS3 integrates with ConfigSync.

#### How AS3 solves this (reference)

AS3 stores its persistent settings in a tmsh data-group
(`/Common/appsvcs/settings`) which IS synced by ConfigSync natively.
AS3 also exposes a `syncToGroup` property in the declaration that, when
set, causes AS3 to call `tmsh run cm config-sync to-group <group>` after
a deploy. AS3 doesn't invent a custom replication layer — it makes its
data ConfigSync-native by storing it in synced TMOS objects, and triggers
sync via the existing `cm config-sync` command.

This pattern doesn't translate directly to Rülbased because our state is a
directory tree of version blobs, manifests, and JSON files (potentially
megabytes per rule), which would be abusive to store in a data-group. But
the *spirit* transfers: treat ConfigSync as the coordination signal, and
align our replication with the operator's existing sync workflow where
possible.

#### Hybrid design

**Three replication pathways, layered:**

1. **Push-on-write (primary path, low latency):** After every successful
   write in `versionStore.js`, `settings.js`, or audit append in
   `notifier.js`, the active device POSTs the delta to peer devices via
   their iControl REST endpoint. New endpoint on each device's Rülbased
   worker: `POST /rules/peer-apply` that accepts a delta record, validates
   it (HMAC-signed from the peer using a shared secret stored on both
   devices), and applies it locally. Push-on-write gives operators the
   expected "I clicked Deploy on A, it immediately shows up on B" feel

2. **Periodic reconciliation (safety net):** A background task runs every
   60s on each device, asks peers for their current version-store manifest
   hash, and pulls deltas for anything it's missing. Catches writes that
   the push-on-write path missed (peer was unreachable, network partition,
   restnoded crash mid-push). Eventually-consistent — a peer that was
   down for an hour catches up within a minute of coming back

3. **Manual reconcile button (operator escape hatch):** Settings modal
   gains a "Force sync now" button that triggers an immediate full
   reconciliation with peers. For operators who want to verify state, or
   recover from a weird edge case

#### Device discovery

Rülbased reads `/mgmt/tm/cm/device` on startup to enumerate peers in the
local device's device-groups. An operator setting `haSyncGroup` (default
auto-detect) lets operators scope sync to a specific device-group in
multi-group topologies, analogous to AS3's `syncToGroup`. If no device-
groups are configured (standalone BIG-IP), Rülbased detects that and
skips all HA code paths entirely — zero overhead on standalone.

#### What syncs, what doesn't

**Syncs across all devices in the HA sync group:**
- Rule manifests (the per-rule `.json` files including `versions[]`,
  acknowledgement state, commit messages, authors)
- Blob objects (the content-addressed TCL bodies)
- `settings.json` (so operator intent — poll interval, webhook URL, syslog
  enablement, theme preference — is consistent across devices)
- Audit log entries (**but** each entry carries a `device` field
  identifying where the action originated; entries from multiple devices
  interleave in the unified audit log, with device attribution preserved
  per-entry)

**Does NOT sync (stays per-device):**
- Nothing — but the `device` field on each audit entry makes the
  distinction visible in the GUI. An operator viewing the audit log on
  Device A sees "Device A deployed X at T=100; Device B deployed Y at
  T=105" rather than an ambiguous merged log

The `device` field on audit entries is the BIG-IP hostname, captured
at worker startup via `tmsh list sys global-settings hostname` (cached
per-worker-instance). Syslog messages emitted by `notifier.js` also
gain the device hostname prefix for consistency with the audit log.

#### Conflict resolution

Audit log entries use `device + timestamp + randomId` as a composite
primary key. Merging two devices' logs is a union operation (entries
keyed by composite ID). No entry is ever overwritten; the audit log is
append-only and merge-friendly by design.

Rule manifests and settings are last-writer-wins per-field, using a
Lamport-clock-style counter (`.lastModifiedByDevice`,
`.lastModifiedGeneration`) that increments on every write. During
reconciliation, the side with the higher generation wins, with tie-break
by device hostname lexicographic order. This is a pragmatic choice —
a formally correct CRDT is overkill for this workload where operators
are rarely making conflicting edits simultaneously.

#### Settings sync gotcha

The AS3 GitHub issue #525 surfaced a known race: when the data-group
syncs faster than the in-memory API state updates on the peer, brief
inconsistency windows exist. Our equivalent: after a
`POST /peer-apply` is received and processed, the receiving device's
worker needs to re-read its own on-disk settings (because our in-memory
cache is now stale). We handle this by invalidating the in-memory cache
on every `/peer-apply` call and letting the next read reload from disk.

#### Failure modes

- **Peer unreachable during push:** the push returns an error; the
  periodic reconciliation picks it up within 60s. Audit entry tagged as
  "pending replication" until reconciled (visible in GUI as a subtle badge)
- **Peer unauthenticated / HMAC mismatch:** reject with 403; log a loud
  warning; the operator must run the new `rulbased-configure-ha` CLI
  (shipped inside the RPM like `post-install.sh`) to re-establish trust
- **Split-brain (both devices active briefly):** both sides log audit
  entries; reconciliation merges them; last-writer-wins resolves manifest
  diverge. No data is lost; operator can inspect both entries in audit log
- **Peer crashes mid-reconciliation:** the receiving side's writes are
  idempotent (same composite key → same record); partial reconciliation
  is safe to retry

#### Packaging

Single RPM, no sidecar (confirmed in planning). HA code lives in main
worker bundle, gated by `_detectHaMode()` helper that runs at worker
startup and caches the result. Standalone BIG-IPs pay zero runtime cost.

#### Post-install setup for HA

Extends `post-install.sh` (from Phase 7) with an HA setup mode:
`post-install.sh --ha` detects device-group membership and generates a
shared HMAC secret stored at `/var/config/rest/iapps/rulbased/data/.ha-secret`
(chmod 0600, owned by restnoded). Operator runs this on BOTH devices with
the same secret passed as an argument, OR the script uses iControl REST
to exchange the secret between peers (operator provides admin creds for
the peer during setup).

A `rulbased-configure-ha` CLI tool (new in Phase 9) handles secret
rotation, peer list updates, and force-reconciliation from the command
line for operators who want scripted HA management.

**Deliverables:**
- `_detectHaMode()` in `rulesWorker.onStart` that reads
  `/mgmt/tm/cm/device` and `/mgmt/tm/cm/device-group`, caches peer list
- `peerClient.js` new lib: HMAC-signed iControl REST calls to peers
- `POST /rules/peer-apply` endpoint on rulesWorker: receive-side handler
- Push-on-write hooks in `versionStore.saveVersion`, `settings.update`,
  and `notifier.appendAudit`
- Periodic reconciliation worker (`haReconciler.js`) similar structure
  to `pollWorker.js`
- `device` field added to all audit log entries (backward-compatible —
  old entries read as `device: "unknown"`)
- `lastModifiedByDevice` / `lastModifiedGeneration` fields on manifests
  (migration v2→v3 — see migration note below)
- Composite-key schema for audit log entries (migration v2→v3)
- GUI: audit log displays Device column; dashboard shows peer status
  indicator; Settings gains "HA configuration" section with peer list,
  sync group, force-sync button, and HMAC rotation UI
- Syslog notifier prefixes device hostname on all messages
- `rulbased-configure-ha` CLI tool shipped in `build/`, added to RPM
  payload
- `post-install.sh --ha` mode for initial HA setup
- README: new "HA deployment" section explaining the model and setup steps
- `configProcessor.VERSION` → `2.2.0`
- Migration: the existing `migrations.js` gets a v2→v3 step that adds
  `device: <hostname>` and composite-key IDs to existing audit entries,
  and adds `lastModifiedByDevice` / `lastModifiedGeneration` to
  existing manifests. Idempotent. Tested on a populated version store
  before release
- Test matrix: standalone, active/standby, active/active, failover,
  split-brain recovery, peer unreachable, HMAC rotation, large backfill
  (simulating a new device joining an existing HA pair)

**Phase 9 risks to track:**
- HMAC secret distribution is a footgun similar to Phase 7's post-install
  step — operators will forget to run it on both devices, or get the
  secret out of sync. The setup CLI should detect mismatches loudly
- Push-on-write adds latency to deploy/save operations; measure and
  document overhead; consider making push-on-write async (fire-and-forget
  with retry queue) if latency is unacceptable
- Reconciliation loop interacts with poll worker — need to make sure
  they don't deadlock or double-write during their overlap
- Operators may have existing data on one device and none on the peer
  when they enable HA — the backfill path must be robust
- iControl REST file-transfer for blob objects has size/quota limits
  worth checking; fall back to chunked upload if needed

---

### Phase 10 — Code review, security audit, and cleanup

**Purpose:** Before declaring the codebase production-grade (target release
v2.3.0), perform a systematic review to identify and resolve latent
issues. Phase 10 is the final pre-production pass; it runs after Phase 8
(UX features) and Phase 9 (HA awareness) are shipped and in use. The
value of running this phase last is that the HA code from Phase 9 will
itself need review, and Phase 10 can review the full codebase including
both recent additions rather than chasing a moving target.

**Review scope:**

- **Dev artifacts:** console.log statements, debug flags left on, placeholder
  comments, TODO/FIXME markers, commented-out code blocks, test-only endpoints
  that should be removed or gated
- **Inconsistencies:** function naming conventions, error response shapes across
  workers (some use `{ error }`, some `{ ok, error }` — standardise), HTTP status
  codes used for each error class, audit log `action` value vocabulary (some use
  hyphens, some underscores)
- **Security concerns:** input validation on all user-supplied fields (partition
  names, rule names, import archive contents — path traversal prevention on tar
  extract); webhook URL validation (reject non-http/https schemes); audit log
  injection prevention; confirm no credentials logged anywhere; review `isPublic`
  and `isPassThrough` settings on all workers (should unauthenticated requests
  be possible?); HMAC comparison uses `===` not `crypto.timingSafeEqual` —
  fix timing oracle
- **Data architecture issues:** audit log is unbounded append-only with no
  rotation — add configurable max size or age-based rotation; `_tasks` in-memory
  Map has no upper bound — add eviction; orphaned blob cleanup only runs on
  retention trim, not on manifest delete — ensure `_deleteRuleFromStore` also
  cleans blobs; `settings.json` is read into memory on startup and written
  atomically on update — confirm write is truly atomic (temp file + rename)
- **API surface review:** any endpoints returning 500 that should return 400;
  any endpoints missing input validation; any endpoints that could be merged or
  removed; confirm all routes are documented in PLANNING.md REST API table
- **Node 6 compatibility pass:** confirm no ES6+ syntax has crept in; run
  `node --check` on all files (add to build checklist permanently)
- **Performance:** poll worker holds `bigipClient.listAllRules()` result in
  memory during comparison — confirm no unbounded growth for large rule sets;
  diff computation is O(n²) LCS — acceptable for typical iRule sizes but
  document the limit

**Deliverables:**
- Annotated issue list with severity (blocker / should-fix / nice-to-have)
- All blockers and should-fixes resolved before cutting v2.3.0 RPM
- PLANNING.md updated with any new architectural decisions
- README updated with any changed behaviour
- `configProcessor.VERSION` → `2.3.0`; RPM version bump accordingly

---

## Project risks (ongoing)

This risk register applies across all phases. Mitigations marked "Already
mitigated" are resolved; the remainder are active considerations.

| Risk | Mitigation |
|------|------------|
| restnoded Node.js version is old (Node 6 on TMOS 13/14) | Avoid ES6+ syntax in processor code; no arrow functions, no `const`/`let` in hot paths, no template literals in production code; test on Node 6 |
| `fs.mkdir` `{ recursive }` not available on Node 6 | Already mitigated: `_mkdirpLegacy` fallback implemented in `versionStore.js` |
| tmsh `save sys config` is slow on large configs (can take 10–30s) | Moot — deploy now uses iControl REST PATCH which commits synchronously and does not require save sys config |
| Poll worker stacking during failover | Already mitigated: single-flight `_running` boolean lock in `pollWorker.js` |
| Large iRule content exceeding REST response buffer | iControl REST returns full `apiAnonymous` content in a single JSON response; BIG-IP enforces a 32MB response limit which is far above any realistic iRule size |
| localhost:8100 trusted channel unavailable | Only occurs if restjavad is not running (system startup/failover). `bigipClient.js` surfaces a clear ECONNREFUSED error; the poll worker's single-flight lock prevents cascading failures |
| GitHub PAT stored insecurely | Store as encrypted iApps LX block input property; never return in plain text via GET; mask in settings UI (Phase 11 — optional) |
| Template variable injection | Sanitise variable values against `^[a-zA-Z0-9._\-/]+$` before substitution (Phase 11 — optional) |
| CodeMirror bundle size | Inlined directly into `app.html` as `<script>`/`<style>` blocks (~187KB). No vendor file requests. CDN not used. `bundle-codemirror.sh` available if separate vendor files are needed for RPM size reasons. |
| BIG-IP management plane has no outbound internet | GitHub integration (Phase 11 — optional) requires outbound HTTPS on port 443; document network requirement; all other features work fully offline |
| Concurrent deploys to the same iRule | Already mitigated: per-rule deploy lock (`_deployLock` in-memory Map) in `rulesWorker.js` |

---

## File structure (complete)

```
rulbased/
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
│       ├── githubWorker.js        ← REST: /github (Phase 11 — optional)
│       ├── bigipClient.js         ← iControl REST reads+writes via localhost:8100 ✅
│       ├── notifier.js            ← syslog + webhook notifications (Phase 5) ✅
│       ├── tmsh.js                ← tmsh child process wrapper ✅
│       ├── versionStore.js        ← filesystem version store ✅
│       ├── pollWorker.js          ← scheduled change detection ✅
│       ├── githubClient.js        ← GitHub API v3 HTTP client (Phase 11 — optional)
│       ├── settings.js            ← in-memory settings + persistence ✅
│       ├── blockUtil.js           ← iApps LX state transition helpers ✅
│       ├── logger.js              ← restnoded logger wrapper ✅
│       ├── migrations.js          ← schema migration framework ✅
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
  store only the path in settings. Decision deferred to Phase 11 (optional).

---

### Phase 11 — GitHub integration (optional — scope and security TBD)

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
- `lib/githubWorker.js` — restnoded worker at `shared/rulbased/github`
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
