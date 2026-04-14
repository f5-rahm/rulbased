# iRule Versioner — Project Planning Document

This document captures all design decisions, data models, API contracts, GUI
specifications, and phase-by-phase deliverables for the iRule Versioner iApps
LX extension. It is intended to provide full context for continuing development
across sessions without needing to re-litigate decisions already made.

---

## Resuming this project

If starting a new session, paste this file (or upload it) and use a prompt
along the lines of:

> I am building an iApps LX extension for BIG-IP called "iRule Versioner".
> The attached PLANNING.md contains all spec decisions, data models, REST API
> definitions, GUI specifications, and the current implementation status.
> Phase 1 is complete. Please read the planning doc and help me continue with
> Phase 2.

The Phase 1 source code is in `irule-versioner-phase1.zip`. Upload both files
to give the new session full context.

---

## Project overview

An iApps LX RPM package installed on BIG-IP that provides version control for
iRules. Operators can snapshot, diff, deploy, and rollback iRules through a
built-in GUI served inside BIG-IP TMUI. Versions are stored locally on the
BIG-IP filesystem. A GitHub integration (Phase 4) allows pushing and pulling
iRules to/from a remote repository, with support for both static iRules and
per-device parameterised templates.

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

### Template iRule format (GitHub — Phase 4)

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
| POST | `/export` | 5 | Trigger tar.gz export of full version store |
| POST | `/import` | 5 | Import a tar.gz version store archive |

### Settings worker (`/settings`)

| Method | Path | Phase | Description |
|--------|------|-------|-------------|
| GET | `/settings` | 1 | Read all global settings (credentials masked) |
| PUT | `/settings` | 1 | Update global settings |

### GitHub worker (`/github`) — Phase 4

| Method | Path | Phase | Description |
|--------|------|-------|-------------|
| GET | `/github/status` | 4 | Connection status, auth method, last sync time |
| POST | `/github/test` | 4 | Test GitHub connectivity and credentials |
| GET | `/github/browse?repo=:repo&path=:path&branch=:branch` | 4 | Browse repo contents (file picker in GUI) |
| POST | `/rules/:partition/:name/github/link` | 4 | Link rule to a GitHub file `{ repo, path, branch, type }` |
| DELETE | `/rules/:partition/:name/github/link` | 4 | Unlink rule from GitHub |
| POST | `/rules/:partition/:name/github/pull` | 4 | Pull from GitHub, render template if needed |
| POST | `/rules/:partition/:name/github/push` | 4 | Push current live version to GitHub |

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

#### Right panel — GitHub tab (Phase 4)

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

**Status:** Implemented, unit tested (16/16 passing), and validated on BIG-IP TMOS 14.x.

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

**Remaining open items for Phase 2+:**
- Orphaned blob files (versions pruned by retention policy) not yet cleaned up —
  deferred to Phase 5.
- `settings.js` `load()` not wired into startup — settings currently use
  in-memory defaults only. Wire into `onStart` in Phase 2.
- Deploy endpoint not yet tested on real device (Phase 2 — requires GUI confirm
  flow to be useful in practice).
- Poll worker interval is hardcoded to 300s in `_startPollWorker` — should read
  from settings once settings persistence is wired up (Phase 2).

---

### Phase 2 — Full-page GUI + history + deploy flow (2–3 weeks)

Deliverables:
- `presentation/app.html` — full-page master-detail SPA
- Left panel: searchable iRule list with flat/partition/VS grouping toggle
- Right panel: Overview tab with read-only CodeMirror TCL viewer
- Right panel: History tab with version timeline
- Side-by-side diff viewer (line-level, colour-coded)
- Two-step deploy/rollback flow: diff modal + mandatory reason field
- PUT `/rules/:p/:n/retention` endpoint
- GET `/audit` endpoint with pagination and rule filter
- Right panel: Audit tab (per-rule filtered view)
- In-GUI toast notifications
- "Edit" button unlocking inline CodeMirror editor + save → deploy flow
- CodeMirror bundled in `presentation/vendor/` (TCL mode, < 200KB)
- Deploy endpoint made async: returns task ID, GUI polls for completion

---

### Phase 3 — Syslog + webhook notifications (1–2 weeks)

Deliverables:
- Syslog emission via `tmsh log local0.notice` from config processor on
  deploy/rollback/drift events
- Webhook HTTP POST from Node.js `http`/`https` module (no external deps)
- Optional HMAC-SHA256 `X-Hub-Signature-256` header when `webhookSecret` is set
- Settings page in GUI: poll interval, syslog toggle, webhook URL + secret
- "Test webhook" button in settings (sends a test POST)
- Webhook retry logic: 3 attempts with 5s backoff, failure logged to audit

---

### Phase 4 — GitHub integration (3–4 weeks)

Deliverables:
- `githubWorker.js` — new iControl LX worker registered at `/github`
- GitHub REST API v3 client in `lib/githubClient.js` (built-ins only: `https`)
- PAT auth: Bearer token in `Authorization` header
- GitHub App auth: JWT generation using RS256 (implement without `jsonwebtoken`
  library — use Node.js `crypto` module directly), exchange for installation
  access token, cache token with expiry
- GET `/github/status` and POST `/github/test`
- GET `/github/browse` — repo file tree for GUI file picker
- Link/unlink endpoints
- Pull flow: fetch file content (base64 decode), detect static vs template,
  render `{{variables}}`, show diff, confirm, snapshot
- Push flow: read live content, base64 encode, PUT to GitHub Contents API
  (requires previous file SHA for conflict detection)
- Conflict detection: compare stored `remoteSha` against current GitHub SHA
- Template variable substitution with allowlist sanitisation
- Per-device variable map editor in GitHub tab
- GitHub tab in full-page GUI

---

### Phase 5 — Import/export + upgrade hardiness (2 weeks)

Deliverables:
- POST `/export` — streams a tar.gz of the full data directory
- POST `/import` — accepts a tar.gz, validates structure, merges or replaces
- Import conflict handling: if a rule already has versions, prompt user to
  merge (append imported versions) or replace (overwrite manifest)
- Orphaned blob cleanup: on manifest save, remove `.tcl` blobs in the rule
  directory that are not referenced by any version entry
- Data migration framework: `lib/migrations.js` — version-stamped migration
  functions run on startup if stored schema version < current schema version
- RPM `%post` improvements: detect TMOS version for correct restart command
- Export/import UI in settings page
- README updates for upgrade procedures

---

## Key implementation risks and mitigations

| Risk | Mitigation |
|------|------------|
| restnoded Node.js version is old (Node 6 on TMOS 13/14) | Avoid ES6+ syntax in processor code; no arrow functions, no `const`/`let` in hot paths, no template literals in production code; test on Node 6 |
| `fs.mkdir` `{ recursive }` not available on Node 6 | Already mitigated: `_mkdirpLegacy` fallback implemented in `versionStore.js` |
| tmsh `save sys config` is slow on large configs (can take 10–30s) | Deploy endpoint should return a task ID immediately; GUI polls `/rules/:p/:n/deploy/status/:taskId` for completion rather than blocking the HTTP response |
| Poll worker stacking during failover | Already mitigated: single-flight `_running` boolean lock in `pollWorker.js` |
| Large iRule content exceeding REST response buffer | iControl REST returns full `apiAnonymous` content in a single JSON response; BIG-IP enforces a 32MB response limit which is far above any realistic iRule size |
| localhost:8100 trusted channel unavailable | Only occurs if restjavad is not running (system startup/failover). `bigipClient.js` surfaces a clear ECONNREFUSED error; the poll worker's single-flight lock prevents cascading failures |
| GitHub PAT stored insecurely | Store as encrypted iApps LX block input property; never return in plain text via GET; mask in settings UI |
| Template variable injection | Sanitise variable values against `^[a-zA-Z0-9._\-/]+$` before substitution |
| CodeMirror bundle size | Bundle only TCL mode + core; target < 200KB; do not load from CDN |
| BIG-IP management plane has no outbound internet | GitHub integration requires outbound HTTPS on port 443; document network requirement; all other features work fully offline |
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
│   ├── index.js                   ← restnoded entry: exports all workers
│   └── lib/
│       ├── configProcessor.js     ← block lifecycle: BINDING → BOUND
│       ├── rulesWorker.js         ← REST: /rules (Phase 1+)
│       ├── settingsWorker.js      ← REST: /settings
│       ├── githubWorker.js        ← REST: /github (Phase 4)
│       ├── bigipClient.js         ← iControl REST reads via localhost:8100 (no credentials)
│       ├── tmsh.js                ← write operations only: deploy + save config
│       ├── versionStore.js        ← filesystem version store
│       ├── pollWorker.js          ← scheduled change detection
│       ├── githubClient.js        ← GitHub API v3 HTTP client (Phase 4)
│       ├── settings.js            ← in-memory settings + persistence
│       ├── blockUtil.js           ← iApps LX state transition helpers
│       ├── logger.js              ← restnoded logger wrapper
│       └── migrations.js          ← schema migration framework (Phase 5)
├── presentation/
│   ├── index.html                 ← embedded summary widget (Phase 1) ✅
│   ├── app.html                   ← full-page master-detail GUI (Phase 2)
│   └── vendor/
│       ├── codemirror.min.js      ← bundled CodeMirror (Phase 2)
│       └── codemirror.min.css     ← bundled CodeMirror styles (Phase 2)
├── build/
│   ├── build-rpm.sh               ← local rpmbuild, no credentials ✅
│   └── install-rpm.sh             ← install on BIG-IP, $BIGIP_PASS env ✅
└── test/
    └── unit.js                    ← tmsh parser + versionStore tests ✅
```

Files marked ✅ are complete. All others are planned for the phase indicated.

---

## Decisions deferred / not yet made

- **Read path: iControl REST via localhost:8100** ✅ DECIDED (Phase 1)
  Reads (`listAllRules`, `getRuleContent`) use `http.get` to
  `localhost:8100/mgmt/tm/ltm/rule` with no credentials. restnoded's implicit
  trust on this channel means no auth header is needed. The REST `apiAnonymous`
  field returns clean TCL content with no tmsh metadata — eliminating the parser
  entirely. tmsh is retained for write operations only.


- **Async deploy task tracking:** Phase 2 needs a mechanism for the deploy
  endpoint to return a task ID and allow the GUI to poll for status. Options:
  (a) in-memory Map in the rulesWorker module; (b) a small `tasks.json` file
  in the data directory. Decision deferred to Phase 2 implementation.

- **Webhook payload signing algorithm:** HMAC-SHA256 matches GitHub's own
  webhook format, making it familiar. Alternative is a shared secret in an
  `Authorization` header. Decision: use HMAC-SHA256 (`X-Hub-Signature-256`)
  to match GitHub convention, but implement in Phase 3.

- **Import conflict UI:** when importing a tar.gz that contains versions for
  rules that already have local history, the user needs to choose merge vs
  replace. The exact UI treatment (modal per-rule vs global choice) is
  deferred to Phase 5.

- **GitHub App private key storage:** PEM keys are multi-line and don't store
  cleanly in a single iApps LX block property. Options: (a) store as a single
  `\n`-escaped string; (b) write to a separate file in the data directory and
  store only the path in settings. Decision deferred to Phase 4.
