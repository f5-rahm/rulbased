# Rülbased — iApps LX Extension for BIG-IP

Version control for BIG-IP iRules, running entirely on-device. Snapshot, diff,
deploy, and rollback iRules through a built-in GUI served directly from the
BIG-IP management plane — no external dependencies, no agents, no added
infrastructure.

---

## What's new in 2.2

- **TCL linter** — 16 client-side lint rules based on the F5 iRules Style
  Guide. Checks for unbraced variables, missing event priorities, brace
  placement, missing `--` terminators, `and`/`or` operators, single-line `if`,
  and more. Gutter markers (warning triangles, info circles) with hover
  tooltips. Three modes: `warn` (show markers), `strict` (block deploy), `off`.
  Per-rule toggles in **Settings → Linting**.
- **Pre-flight validation** — the **Validate** button in the editor creates a
  throwaway rule on the BIG-IP to check TCL syntax, then deletes it
  immediately. Deploy always validates first and blocks on failure.
- **Tab/Shift-Tab indent** — Tab inserts 4 spaces (or bulk-indents a
  selection), Shift-Tab outdents. Matches the F5 style guide's "indent 4
  spaces, no tab characters" rule.
- **Webhook preview** — **Preview Webhook Payload** in Settings generates a
  sample event payload and verifies HMAC signing without making any HTTP
  request. See [Testing webhooks](#testing-webhooks) for external receiver
  setup.
- **Comment style lint** — enforces the style guide's `# comment` (space for
  real comments) vs `#command` (no space for commented-out code) convention.

---

## What's new in 2.1

- **Acknowledge all** — clear the `NEW` badge on every newly-baselined rule in
  one action. Exposed as a clickable `New` stat on the dashboard and a toolbar
  button in the left panel. Drifted rules are skipped server-side so that a
  real external change never gets silently cleared. The whole bulk operation
  emits a single audit-log entry.
- **Hide F5 system iRules** — rules whose name starts with `_sys_` *and* whose
  body begins with `nodelete nowrite` are filtered from the rule list, the
  dashboard counters, and the poll worker by default. Toggle in **Settings →
  Rule list**. The GUI shows `N F5 system iRules hidden` at the bottom of the
  rule list when the filter is active. System rules never accumulate
  `_sys_*.json` manifests on disk when the filter is on.
- **Versions tab** — new tab alongside `History` that collapses the version
  timeline by content hash. If a rule has been rolled back-and-redeployed
  twenty times between two distinct versions, `Versions` shows two rows (one
  per unique content hash, with an appearance count and last-deployed
  timestamp) while `History` continues to show the full twenty-entry
  append-only timeline. The `Deploy` button now lives on `Versions` — `Diff`
  stays on `History`.
- **Dark mode** — three-way theme setting (`Light` / `Dark` / `Auto`) in
  **Settings → Appearance**. `Auto` follows `prefers-color-scheme` (standalone
  tab) and the parent TMUI body class (embedded iframe). Default is `auto`.
  Dark palette is applied via CSS variable overrides on top of CodeMirror's
  bundled `cm-s-default` theme — the F5 red and jade-green brand colors used
  for events and namespace commands are preserved across both themes.
- **Expanded iRules syntax highlighting** — the overlay now colors all 93
  top-level iRules commands from the F5 CloudDocs *Commands* page in F5 red
  (`when`, `log`, `call`, `pool`, `node`, `snat`, `virtual`, `reject`, `drop`,
  `forward`, `priority`, `timing`, `event`, `after`, `proc`, `return`,
  `persist`, and 76 others), alongside the existing coverage for events and
  namespaced commands. Names that collide with TCL keywords (`proc`, `return`,
  `after`, `class`) now take the iRules color inside an iRule, which is how
  iRule authors read them.
- **Click-to-docs now requires Ctrl/Cmd** — CloudDocs navigation on linked
  tokens was previously triggered by any click, which prevented placing the
  text cursor inside a highlighted word. Plain clicks now place the cursor as
  usual; hold **Ctrl** (or **Cmd** on macOS) and click to open the docs page.
  Matches the "go-to-definition" gesture used by every mainstream IDE.
- **History tab shows inline audit events** — acknowledge, remove-from-store,
  and similar audit-only operations are now interleaved as narrow italic info
  rows within the History timeline, so reading one rule's timeline no longer
  requires cross-referencing a separate tab.
- **Compare checkbox on History and Versions** — the two-version compare
  selector is available from both tabs, so you can pick compare targets from
  whichever view you're already reading.

---

## Maintenance updates since 2.1.0

### Phase 8.5 — Deploy path repair + logger fix (in-place; still 2.1.0)

Two pre-existing bugs were repaired without bumping the version. No
user-visible feature changes.

- **Deploy path: iControl REST PATCH → tmsh load merge.** Some iRules
  that the BIG-IP GUI accepts (and `tmm` parses fine at runtime) were
  rejected by iControl REST's `apiAnonymous` validator with `incomplete
  command` errors — F5 Bug ID 657977 and related parser strictness on
  balanced-brace content. `bigipClient.deployRule` now writes the iRule
  body wrapped in `ltm rule /<p>/<n> { ... }` to a per-deploy unique
  `/tmp/rulbased-merge-<ts>-<rand>.tcl` file and runs `tmsh load sys
  config merge file <path>` via `POST /mgmt/tm/util/bash`. The merge
  goes through the same parser the GUI uses, so anything the GUI
  accepts deploys cleanly. After the merge succeeds, the rule is read
  back and SHA-1-compared against the submitted body to confirm what
  `tmm` loaded matches what was sent (whitespace-only diffs are
  tolerated; semantic mismatches fail the deploy). The temp file is
  always cleaned up. Audit/syslog/webhook surfaces are unchanged.
- **logger.js routes through `f5-logger.getInstance()` now.** Previous
  versions checked for a global named `logger`, which doesn't exist in
  iControl LX (per-worker `self.logger` is the framework's pattern, not
  a global). The check always failed, fell through to `console`, and
  every helper-module log line went to `/var/tmp/restnoded.out` instead
  of `/var/log/restnoded/restnoded.log`. Helper modules now use the
  documented `require('f5-logger').getInstance()` pattern. Method names
  also realigned with f5-logger and `self.logger`: `logger.warn` →
  `logger.warning`, `logger.error` → `logger.severe`, `logger.debug` →
  `logger.fine` (info unchanged). A single `grep ' - severe:'` against
  restnoded.log now surfaces errors from every layer.

See `PLANNING.md` → Phase 8.5 for full diagnosis, the dead ends, and
the lessons learned.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Directory structure](#directory-structure)
- [Installing](#installing)
- [Upgrading](#upgrading)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)
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
- iControl REST write path — _superseded in Phase 8.5; see "Maintenance updates since 2.1.0" above_
- Append-only audit log (JSON Lines)

### Phase 2 — Full-page GUI
- Full-page master-detail SPA at `https://<bigip>/mgmt/shared/rulbased/ui`
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

### Phase 7 — Package rename to Rülbased
- RPM renamed from `irule-versioner` to `rulbased` — flag-day rebrand,
  not an in-place upgrade from 1.x
- Worker URIs moved under `/mgmt/shared/rulbased/`; old `/iapps/irule-versioner/`
  paths no longer resolve
- Data directory at `/var/config/rest/iapps/rulbased/data`
- GUI served at `/mgmt/shared/rulbased/ui`

### Phase 8 — UX improvements (v2.1)
- **Acknowledge all** — `POST /rules/acknowledge-all` endpoint; clickable
  dashboard stat + left-panel toolbar button; drifted rules skipped; one
  audit entry for the whole bulk operation
- **Hide F5 system iRules** — `hideSystemRules` setting (default on); detection
  via `_sys_*` name prefix plus `nodelete nowrite` body marker; filters list,
  dashboard counts, and poll-worker manifest creation
- **Versions tab** — client-side aggregation by blob content hash;
  `Deploy` moves here from `History`; `Diff` stays on `History`; two-version
  Compare checkbox available on both `History` and `Versions`
- **Dark mode** — three-way `theme` setting (light / dark / auto); `auto`
  tracks OS `prefers-color-scheme` and the parent TMUI frame; dark palette
  applied via `body.iv-dark .cm-s-default .cm-*` overrides so the bundled
  CodeMirror default theme remains in use and brand colors (F5 red, jade
  green) are preserved across both modes
- **Top-level iRules command highlighting** — 93 commands from the CloudDocs
  *Commands* page (`when`, `log`, `call`, `pool`, `node`, `snat`, `virtual`,
  `reject`, `drop`, `forward`, `priority`, `timing`, `event`, `after`, `proc`,
  `return`, `persist`, …) color in F5 red via the existing `cm-irule-kw`
  class, consistent with events and namespace prefixes. Overlay branch runs
  before the TCL check so names that are also TCL keywords (`proc`, `return`,
  `after`, `class`) render in the iRules color inside an iRule
- **Ctrl+click for CloudDocs** — plain click now places the cursor in the
  word; hold **Ctrl** (or **Cmd** on macOS) to open the CloudDocs page for
  the clicked event, namespace command, top-level command, or TCL command
- **Inline audit events in History** — `acknowledge` and
  `remove-from-store` audit entries are merged into the History timeline as
  narrow italic info rows (client-side merge from a parallel `GET
  /rules/audit` fetch, 2-second dedupe window to avoid double-counting when
  a content-change audit entry is paired with a status-change audit entry)

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
rulbased/
├── PLANNING.md                  ← project spec, design decisions, phase roadmap
├── README.md                    ← this file
├── manifest.json                ← iApps LX package tag
├── block_template.json          ← block input/output property schema
├── nodejs/
│   ├── index.js                 ← restnoded entry point
│   └── lib/
│       ├── bigipClient.js       ← iControl REST reads via localhost:8100;
│       │                          deploy via tmsh load merge through bash util
│       ├── blockUtil.js         ← iApps LX state transition helpers
│       ├── configProcessor.js   ← iApps LX block lifecycle
│       ├── logger.js            ← f5-logger wrapper (info/warning/severe/fine/config)
│       ├── migrations.js        ← schema migration framework (Phase 6)
│       ├── notifier.js          ← syslog + webhook notifications
│       ├── pollWorker.js        ← scheduled change detection
│       ├── rulesWorker.js       ← REST API: /rules/*
│       ├── settings.js          ← in-memory settings with persistence
│       ├── settingsWorker.js    ← REST API: /settings + /settings/test-*
│       ├── tmsh.js              ← legacy child-process wrapper, no longer in
│       │                          deploy path; retained for reference
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
    ├── unit.js                  ← unit tests (37 passing, no framework required)
    └── test-external-change.sh  ← end-to-end external change detection test
```

---

## Installing

### 1. Build the RPM on your local machine

```bash
bash ./build/build-rpm.sh 2.2.0 0001
# Output: build/dist/rulbased-2.2.0-0001.noarch.rpm
```

### 2. Upload and install the RPM to BIG-IP

The install script will prompt for the BIG-IP password if it is not already
set in the `BIGIP_PASS` environment variable:

```bash
bash ./build/install-rpm.sh <host> admin build/dist/rulbased-2.2.0-0001.noarch.rpm
# Password for admin@<host>: ******
```

Or set `BIGIP_PASS` in the environment first (preferred for CI/CD):

```bash
export BIGIP_PASS=<password>
bash ./build/install-rpm.sh <host> admin build/dist/rulbased-2.2.0-0001.noarch.rpm
```

> **Use the BIG-IP `admin` account, not `root`.** BIG-IP blocks `root` from
> iControl REST by design — authentication will fail with 401.

> **macOS note:** the zip archive does not preserve the executable bit on
> extraction. Run the scripts via `bash ./build/install-rpm.sh ...` (as shown
> above), or `chmod +x build/*.sh` once after extraction.

### 3. Run the post-install script on the BIG-IP (required)

The RPM extracts `post-install.sh` to
`/var/config/rest/iapps/rulbased/build/post-install.sh` on the BIG-IP. Run
it via SSH as root to create `/shared/rulbased-backups` (where backup
exports are retained on-device):

```bash
ssh root@<bigip> bash /var/config/rest/iapps/rulbased/build/post-install.sh
```

The script is idempotent — safe to run repeatedly, no-op if everything is
already in place.

> **Why this step is needed.** The iApps LX install pipeline does not
> execute RPM `%post` scriptlets. Installed packages are visible via
> `/mgmt/shared/iapp/global-installed-packages` but absent from the system
> RPM database (`rpm -q <pkg>` returns "not installed"), which means the
> iApps LX framework extracts the RPM payload directly and bypasses the
> scriptlet machinery. Directory creation under `/shared/` (owned root:root
> 0755 by default) requires root privileges that the restnoded worker
> process (uid 198) does not have, so this must be done from a root shell.

### 4. Verify the install

```bash
# All 4 workers should appear (rulesWorker, settingsWorker, uiWorker, configProcessor)
ssh root@<BIGIP> "grep 'has started' /var/log/restnoded/restnoded.log | grep -i rulbased"

# Rules endpoint — returns JSON with items[] (empty on fresh install,
# populated after first poll cycle)
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/rulbased/rules | jq .
# (if jq is not installed, omit '| jq .' or substitute '| python3 -m json.tool')
```

### 5. Access the GUI

```
https://<bigip>/mgmt/shared/rulbased/ui
```

> **Migrating from `irule-versioner` 1.x?** Uninstall the old package first —
> see the [Uninstalling](#uninstalling) section for the full procedure. Both
> packages can technically coexist (they register under different URI paths),
> but the old one's poll worker will keep running and fight with the new one
> over drift detection.

---

## Upgrading

### Upgrading Rülbased (same TMOS version)

```bash
export BIGIP_PASS=<password>
bash ./build/install-rpm.sh <host> admin build/dist/rulbased-2.2.0-0001.noarch.rpm
```

### Before a TMOS version upgrade

Use the GUI Backup button (toolbar → Backup) to download a `.tar.gz` of your
full version history before upgrading TMOS. After upgrading and reinstalling
the RPM, use the Restore button in the same modal to import your history back.

Alternatively, from the command line:

```bash
# Pre-upgrade backup
tar -czf /shared/rulbased-data-backup-$(date +%Y%m%d).tar.gz \
  /var/config/rest/iapps/rulbased/data/

# Post-upgrade restore (after TMOS upgrade + RPM reinstall)
tar -xzf /shared/rulbased-data-backup-<date>.tar.gz -C /
bigstart restart restnoded
```

---

## Uninstalling

The F5-sanctioned way to remove an iApps LX package is the
`package-management-tasks` endpoint with `operation: "UNINSTALL"`. This
deregisters all workers, removes the package's `nodejs/` and `presentation/`
trees, and restarts restnoded — all asynchronously.

### Step 1: Find the exact package name

```bash
export BIGIP_PASS=<password>

# Using jq (from your build machine — uses regex):
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/iapp/global-installed-packages \
  | jq -r '.items[] | select(.packageName | test("rulbased|irule-versioner")) | .packageName'

# Using jq from the BIG-IP itself (no regex support — uses contains):
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/iapp/global-installed-packages \
  | jq -r '.items[] | select(.packageName | contains("rulbased") or contains("irule-versioner")) | .packageName'

# Python fallback (works anywhere python3 is installed):
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/iapp/global-installed-packages \
  | python3 -c "import json,sys; [print(p['packageName']) for p in json.load(sys.stdin)['items'] if 'rulbased' in p['packageName'].lower() or 'irule-versioner' in p['packageName'].lower()]"
```

> **BIG-IP `jq` note:** the jq binary shipped on BIG-IP is compiled without
> the Oniguruma regex library, so `test()`, `match()`, `sub()`, `gsub()`,
> `capture()`, `splits()`, and `scan()` all fail with
> `jq was compiled without ONIGURUMA regex libary`. Use `contains()` and
> string equality instead when running jq commands through SSH on the BIG-IP.
> The build-machine jq (macOS Homebrew, apt, brew, etc.) has regex support
> and the `test()` form works fine there.

You should get output like `rulbased-2.2.0-0001.noarch`.

### Step 2: Submit the UNINSTALL task

```bash
curl -sk -u admin:$BIGIP_PASS -H 'Content-Type: application/json' \
  -X POST https://<BIGIP>/mgmt/shared/iapp/package-management-tasks \
  -d '{"operation":"UNINSTALL","packageName":"rulbased-2.2.0-0001.noarch"}' \
  | jq .
```

The response includes an `id` UUID. The task is asynchronous — the RPM
`%preun` scriptlet fires, workers deregister, and restnoded restarts
(briefly — 5–10 seconds).

### Step 3: Verify the uninstall completed

```bash
# Should return empty — package gone from the installed list:
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/iapp/global-installed-packages \
  | jq -r '.items[] | select(.packageName | contains("rulbased")) | .packageName'

# The Rülbased endpoints should now 404:
curl -sk -u admin:$BIGIP_PASS -w "\nHTTP %{http_code}\n" \
  https://<BIGIP>/mgmt/shared/rulbased/rules
# Expected: HTTP 404
```

### What uninstall does and does not remove

| Path / resource | Effect |
|---|---|
| `/var/config/rest/iapps/rulbased/nodejs/`, `/presentation/`, `manifest.json`, `block_template.json` | Removed (RPM-managed) |
| `/var/config/rest/iapps/rulbased/data/` | **Preserved** — version history survives uninstall |
| `/shared/rulbased-backups/` | **Preserved** — export archives retained |
| `/var/config/rest/downloads/rulbased-*.rpm` | **Preserved** — the uploaded RPM stays cached |
| restnoded workers | Deregistered (restnoded is restarted by the framework) |

If you want the data directory gone too (e.g. moving from `irule-versioner`
to `rulbased` and no longer need the old history):

```bash
ssh root@<BIGIP> "rm -rf /var/config/rest/iapps/rulbased/"
# or for the legacy 1.x package:
ssh root@<BIGIP> "rm -rf /var/config/rest/iapps/irule-versioner/"
```

To also clear the backup directory:

```bash
ssh root@<BIGIP> "rm -rf /shared/rulbased-backups/"
```

---

## Troubleshooting

### Backup download says "On-device copy skipped"

The browser download worked, but the `/shared/rulbased-backups/` copy
didn't happen. Cause: the backup directory doesn't exist, and restnoded
(uid 198) can't create subdirs under `/shared/` (root:root 0755).

Fix — run the post-install script as root:

```bash
ssh root@<BIGIP> bash /var/config/rest/iapps/rulbased/build/post-install.sh
```

Then retry the backup. Existing downloaded backups are unaffected.

### Everything works except exports — worker seems fine otherwise

Same root cause as above. The `/rules/export` endpoint uses
`/shared/rulbased-backups/` for on-device retention; if it's missing,
only the on-device copy fails (the browser download still works and
returns `devicePathError` in the JSON response indicating what to fix).

### Install "succeeded" but `/shared/rulbased-backups` was never created

Known behavior — the iApps LX install pipeline bypasses RPM scriptlets.
The package shows up in `/mgmt/shared/iapp/global-installed-packages` but
is absent from the OS-level RPM database:

```bash
rpm -q rulbased
# package rulbased is not installed
```

This is by design on the F5 side and affects every iApps LX extension.
Always run `post-install.sh` after install. See the
[Installing](#installing) section.

### GUI loads but returns 404 or "Worker not found" on endpoints

Check that restnoded has the workers registered:

```bash
ssh root@<BIGIP> "grep 'has started' /var/log/restnoded/restnoded.log | grep -i rulbased | tail -5"
```

You should see four workers: `configProcessor`, `rulesWorker`,
`settingsWorker`, `uiWorker`. If any are missing, check the log for
syntax errors:

```bash
ssh root@<BIGIP> "tail -100 /var/log/restnoded/restnoded.log | grep -iE 'error|exception|unexpected'"
```

### Post-install marker file

The `post-install.sh` script and the RPM `%post` (on systems that do run
it) both write a diagnostic marker at
`/var/config/rest/iapps/rulbased-post-install.log`. Reading it tells you
which setup path actually executed:

```bash
ssh root@<BIGIP> "cat /var/config/rest/iapps/rulbased-post-install.log"
```

---

## Re-baselining

```bash
ssh root@<BIGIP> "rm -rf /var/config/rest/iapps/rulbased/data/*"
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

All endpoints are under `/mgmt/shared/rulbased/`.

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

### Testing webhooks

Rülbased ships two ways to verify webhook functionality:

**Preview Webhook Payload** (no external dependency)

Open **Settings → Notifications** and click **Preview Webhook Payload** at the
bottom. This generates a sample event payload server-side and displays it
inline, including HMAC-SHA256 signature verification if a webhook secret is
configured. No HTTP request is made — useful for verifying your secret is
correct and seeing the exact payload format.

**Send Test Webhook** (requires an external receiver)

Set a **Webhook URL** and optionally a **Webhook HMAC secret**, save settings,
then click **Send Test Webhook**. This fires a real HTTP POST to the configured
URL with a synthetic `test` event. The receiver must be reachable from the
BIG-IP management interface.

For demos and lab testing, a simple netcat-based receiver can stand in for a
real webhook destination. Save the script below as `webhook-listener.sh` on a
jump host or lab machine reachable by the BIG-IP:

```bash
#!/usr/bin/env bash
# webhook-listener.sh — minimal webhook receiver for Rülbased demos
# Usage: bash webhook-listener.sh [port]
# Default port: 9999
PORT="${1:-9999}"
echo "Listening for webhooks on port ${PORT}..."
echo "Configure Rülbased webhook URL: http://$(hostname -f):${PORT}"
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
    echo "$reqline"
    echo -e "$headers" | grep -i "x-hub-signature\|content-type\|user-agent"
    if [ -n "$body" ]; then
      echo "$body" | python -m json.tool 2>/dev/null || echo "$body"
    fi
    echo -e "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
  } < <(nc -l "$PORT")
  echo ""
done
```

**Demo setup:**

1. On the jump host, start the listener:

   ```bash
   bash webhook-listener.sh 9999
   ```

2. In Rülbased **Settings → Notifications**:
   - Set **Webhook URL** to `http://<jump-host>:9999`
   - Set **Webhook HMAC secret** to any value (e.g., `demodemo`)
   - Click **Save Settings**

3. Click **Send Test Webhook** — the listener terminal should display the
   payload with event `test` and the `X-Hub-Signature-256` header.

4. Now edit and deploy an iRule — the listener shows a real `deploy` event
   with the rule path, content hashes, author, reason, and timestamp.

**Sample webhook payload:**

```json
{
    "event": "deploy",
    "rule": "/Common/my_irule",
    "fromHash": "a1b2c3d4...",
    "toHash": "f9e8d7c6...",
    "author": "admin",
    "reason": "CR-1234 — Adding HSTS header",
    "timestamp": "2026-05-12T14:30:00.000Z",
    "device": "bigip1.lab.local"
}
```

Events: `deploy`, `rollback`, `external-change-detected`, `test`.

---

## TCL linter

### Lint modes

| Mode | Gutter markers | Blocks deploy? |
|------|---------------|----------------|
| **Warn** (default) | Amber triangles (warnings), blue circles (info) | No |
| **Strict** | Red X's (warnings promoted to errors), blue circles (info) | Yes — warning-level violations block Validate and Deploy |
| **Off** | None | No |

Info-level annotations (trailing whitespace, line length, comment style) never
block deploy regardless of mode.

### Built-in rules

| Rule ID | Severity | What it checks |
|---------|----------|----------------|
| `unbraced-var` | warning | `$foo` → suggest `${foo}` |
| `unbraced-expr` | warning | `expr 3 * 4` → suggest `expr {3 * 4}` |
| `f5-and-or` | warning | `and`/`or` in expressions → use `&&`/`\|\|` (skips strings) |
| `oneline-if` | warning | `if { ... } { ... }` all on one line |
| `multi-cmd-line` | warning | `;` separating commands on one line |
| `brace-on-newline` | warning | `}` on its own line followed by `else`/`elseif` |
| `missing-space-brace` | warning | `}{` without space |
| `missing-priority` | warning | `when EVENT {` without `priority N` — suggests 500 |
| `missing-option-terminator` | warning | `switch` or `table` commands without `--` |
| `tab-character` | warning | Literal tab in non-comment content |
| `trailing-whitespace` | info | Line ending in whitespace |
| `line-too-long` | info | Line exceeds 100 characters |
| `inline-comment` | info | `;#` end-of-line comment |
| `comment-style` | info | `#word` where word is not a command (missing space), or `# command` where command is a known keyword (extra space) |
| `truthy-non-binary` | warning | `"yes"`/`"no"`/`"true"`/`"false"` → use 0/1 |
| `static-no-prefix` | warning | `static::var` without appname prefix (no underscore) |

### Disabling individual rules

Open **Settings → Linting → Per-rule toggles** and uncheck any rule you want
to suppress. The setting is persisted in `settings.json` as the `lintRules`
key, e.g.:

```json
{
  "lintRules": {
    "trailing-whitespace": false,
    "line-too-long": false
  }
}
```

Only disabled rules need entries — all rules are enabled by default.

### Adding a new lint rule

Lint rules are defined in `presentation/app.html` in the "TCL Lint" section
(search for `_registerLintRule`). Each rule follows this pattern:

```javascript
_registerLintRule('rule-id', 'warning', 'Human-readable label', function(line, lineNo, allLines) {
  if (_isCommentLine(line)) { return []; }
  var hits = [];
  // Check the line content and push hits:
  //   hits.push({ from: startCol, to: endCol, message: 'Explain the fix' });
  return hits;
});
```

Parameters of the check function:
- `line` — the current line's text content
- `lineNo` — zero-based line number
- `allLines` — array of all lines (for multi-line checks like `brace-on-newline`)

Each hit needs `from` (start column), `to` (end column), and `message`.
Severity is `'warning'` (blocks in strict mode) or `'info'` (never blocks).
Use `_isCommentLine(line)` to skip lines that start with `#`.

After adding a rule, update `test/test-bad.irule` with a violation and
`test/test-good.irule` with a clean example, then add a matching test in
`test/unit.js`.

---

## Version store layout

```
/var/config/rest/iapps/rulbased/data/
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
| `lintMode` | string | `"warn"` | `strict` (block deploy), `warn` (show only), `off` |
| `lintRules` | object | `{}` | Per-rule overrides, e.g. `{"tab-character": false}` |
| `webhookReceiverEnabled` | boolean | `false` | Enable built-in webhook test receiver |
| `schemaVersion` | integer | `0` | Internal — managed by migrations.js |

---

## Running unit tests

```bash
node test/unit.js
# 59 tests, no framework, no BIG-IP required
```

---

## Key design decisions

**iControl REST for reads, tmsh load merge for writes.** Reads use
`GET /mgmt/tm/ltm/rule?$select=apiAnonymous` via the localhost:8100 trusted
channel. Writes use `tmsh load sys config merge file <path>` invoked via
`POST /mgmt/tm/util/bash` — the iRule body is wrapped in an `ltm rule
/<partition>/<name> { ... }` stanza and written to `/tmp/rulbased-merge-
<ts>-<rand>.tcl` first. After-merge SHA-1 hash verification confirms what
`tmm` loaded matches what was submitted. The merge path uses the same
parser the GUI uses, so any iRule the GUI accepts deploys cleanly. See
PLANNING.md → Phase 8.5 for the full history of why this replaced an
earlier `PATCH apiAnonymous` design (F5 Bug ID 657977).

**Deploy errors use HTTP 200 with `{ ok: false, error }`** — restnoded intercepts
and transforms non-2xx responses before they reach the browser, making the body
unreliable. All errors that need to surface a message in the GUI return 200 with
`ok: false`.

**localhost:8100 authentication** — `Authorization: Basic admin:` (empty password).

**Content-addressed blob store** — `<7-char-sha1>.tcl`. Identical content
auto-deduplicates.

**No npm dependencies** — Node.js built-ins only. Node 6.9.1 compatible.

**CodeMirror inlined** — Full bundle inlined into `app.html`.

**Logging via `f5-logger.getInstance()`** — helper modules acquire the logger
through the documented `require('f5-logger').getInstance()` pattern. Method
names match f5-logger and `self.logger` exactly: `info`, `warning`, `severe`,
`fine`, `config`. Outside restnoded (e.g. running unit tests) the wrapper
falls back to a console-backed shim that produces the same line format.

**TCL syntax validation** — `tmsh load merge` rejects malformed iRules with
the same error format the BIG-IP CLI produces (e.g. `01070151:3: Rule
[/Common/foo] error: incomplete command`). The mcpd error code prefix and
`Rule [/p/n] error:` wrapper are stripped before display in the GUI; the
useful content starts after both.
