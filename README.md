# iRule Versioner — iApps LX Extension

Version-control your BIG-IP iRules: snapshot, diff, deploy, and rollback —
with an integrated GUI inside BIG-IP TMUI.

---

## Contents

- [Phase 1 scope](#phase-1-scope)
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
- [Running unit tests](#running-unit-tests)
- [Key design decisions](#key-design-decisions)

---

## Phase 1 scope

- Automatic baseline snapshot of all iRules on first install
- Local filesystem version store (JSON manifest + TCL blobs per rule)
- Git-style versioning: short SHA-1 hash, author, timestamp, commit message
- Scheduled polling for changes made outside this tool (default: every 5 min)
- REST API: list rules, version history, fetch content, diff, manual snapshot
- Embedded summary widget in BIG-IP TMUI
- tmsh-based iRule deployment (`load sys config merge` + `save sys config`)
- Append-only audit log (JSON Lines)

---

## Requirements

| Component | Version |
|-----------|---------|
| BIG-IP TMOS | 13.0 or later (tested on 21.x) |
| Node.js (restnoded) | 6.x (embedded in TMOS — no install needed) |
| rpmbuild (build machine only) | Any recent version |
| curl (build machine only) | Any recent version |

The BIG-IP user account used for install must have the **Administrator** role.
The `root` OS account cannot be used for iControl REST calls.

---

## Directory structure

```
irule-versioner/
├── PLANNING.md                # Full project spec, design decisions, phase roadmap
├── README.md                  # This file
├── manifest.json              # iApps LX package tag
├── block_template.json        # Block input/output property schema
├── nodejs/
│   ├── index.js               # restnoded entry point
│   └── lib/
│       ├── bigipClient.js     # iControl REST reads via localhost:8100
│       ├── configProcessor.js # iApps LX block lifecycle
│       ├── rulesWorker.js     # REST API: /rules/*
│       ├── settingsWorker.js  # REST API: /settings
│       ├── tmsh.js            # Write operations: deploy + save config
│       ├── versionStore.js    # Filesystem version store
│       ├── pollWorker.js      # Scheduled change detection
│       ├── settings.js        # In-memory settings with persistence
│       ├── blockUtil.js       # iApps LX state transition helpers
│       └── logger.js          # restnoded logger wrapper
├── presentation/
│   └── index.html             # Embedded summary widget (shown in TMUI)
├── build/
│   ├── build-rpm.sh           # Local RPM build — no BIG-IP needed
│   └── install-rpm.sh         # Upload and install on BIG-IP
└── test/
    └── unit.js                # Unit tests (no framework required)
```

---

## Building the RPM

The RPM is built entirely on your local machine — no BIG-IP connection or
credentials required at build time.

```bash
# Install rpmbuild if needed:
#   macOS:         brew install rpm
#   RHEL/CentOS:   sudo yum install rpm-build
#   Ubuntu/Debian: sudo apt install rpm
#
# Or build in a container:
#   docker run --rm -v $(pwd):/src centos:7 bash /src/build/build-rpm.sh 1.0.0 0001

chmod +x build/build-rpm.sh
./build/build-rpm.sh 1.0.0 0001
# Output: build/dist/irule-versioner-1.0.0-0001.noarch.rpm
```

The version and release arguments (`1.0.0 0001`) are embedded in the RPM
filename and reported by the package manager. Increment the release number
(`0002`, `0003`) for patch updates, the minor or major version for feature
releases.

---

## Installing

The password is read from the `BIGIP_PASS` environment variable — never a
positional argument — so it does not appear in shell history or `ps` output.
Use the BIG-IP `admin` account (or another Administrator-role account).

```bash
export BIGIP_PASS=<password>
chmod +x build/install-rpm.sh
./build/install-rpm.sh <host> admin build/dist/irule-versioner-1.0.0-0001.noarch.rpm
```

**What happens during install:**

1. The RPM is uploaded to `/var/config/rest/downloads/` on the BIG-IP.
2. The iControl REST package-management-tasks endpoint installs the RPM,
   placing files under `/var/config/rest/iapps/irule-versioner/`.
3. restnoded restarts automatically and picks up the new workers.
4. On first load, `onStart` fires and:
   - Creates `/var/config/rest/iapps/irule-versioner/data/` if it doesn't exist
   - Takes a baseline snapshot of every iRule currently on the system
   - Starts the poll worker (default interval: 300 seconds)
5. All iRules appear in the version store with `versionCount: 1` and
   `source: "baseline"`.

**The version store data directory is NOT managed by the RPM.** It is created
by the extension itself and intentionally excluded from the RPM file manifest.
This means uninstalling or upgrading the package never deletes your version
history.

---

## Verifying the install

```bash
# All 3 workers should appear
ssh root@<BIGIP> "grep 'has started' /var/log/restnoded/restnoded.log | grep irule-versioner"
# Expected:
#   config: [RestWorker] /shared/iapp/processors/irule-versioner has started. Name:ConfigProcessor
#   config: [RestWorker] /shared/irule-versioner/rules has started. Name:RulesWorker
#   config: [RestWorker] /shared/irule-versioner/settings has started. Name:SettingsWorker

# Baseline should have run
ssh root@<BIGIP> "grep 'baseline complete' /var/log/restnoded/restnoded.log"
# Expected: info: [irule-versioner] RulesWorker.onStart: baseline complete, N rules snapshotted

# Rules endpoint should return your iRules with versionCount: 1
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/irule-versioner/rules \
  | python3 -m json.tool
```

---

## Upgrading

To install a new version of the package:

1. Build the new RPM with an incremented version or release number.
2. Run the install script with the new RPM — the package manager handles the
   upgrade automatically:

```bash
export BIGIP_PASS=<password>
./build/install-rpm.sh <host> admin build/dist/irule-versioner-1.1.0-0001.noarch.rpm
```

**Version store behaviour during upgrade:**

- The data directory (`/var/config/rest/iapps/irule-versioner/data/`) is
  preserved across upgrades. Your version history, manifests, and audit log
  are never touched by the install or uninstall process.
- After upgrade, restnoded restarts and `onStart` fires again. It checks
  whether the data directory already contains partition subdirectories — if it
  does, the baseline is skipped and the poll worker starts immediately. Your
  existing history is intact.
- **A re-baseline is NOT performed on upgrade.** See [Re-baselining](#re-baselining)
  if you want to force one.

---

## Uninstalling

```bash
export BIGIP_PASS=<password>

# Get the exact package name
curl -sk -u admin:$BIGIP_PASS \
  https://<BIGIP>/mgmt/shared/iapp/global-installed-packages \
  | python3 -c "import json,sys; [print(p['packageName']) for p in json.load(sys.stdin)['items'] if 'irule' in p['packageName'].lower()]"

# Uninstall (replace packageName with the value from above)
curl -sk -u admin:$BIGIP_PASS \
  -H "Content-Type: application/json" \
  -X POST https://<BIGIP>/mgmt/shared/iapp/package-management-tasks \
  -d '{"operation":"UNINSTALL","packageName":"irule-versioner-1.0.0-0001.noarch"}'
```

**The version store is NOT deleted on uninstall.** The data directory at
`/var/config/rest/iapps/irule-versioner/data/` remains on disk with your full
version history. To remove it completely:

```bash
ssh root@<BIGIP> "rm -rf /var/config/rest/iapps/irule-versioner/data"
```

Only do this if you are certain you no longer need the version history. There
is no undo.

---

## Re-baselining

A re-baseline takes a fresh snapshot of every iRule currently on the system,
skipping any rule that already has a manifest. It is useful if:

- New iRules were added to the system before the poll worker detected them
- You suspect the version store is out of sync with the current system state
- You have manually deleted individual rule manifests and want them recreated

**Re-baseline is triggered automatically** whenever restnoded starts and finds
the data directory empty (i.e. no partition subdirectories). The simplest way
to force a full re-baseline is:

```bash
# 1. Delete the data directory contents (preserves the directory itself)
ssh root@<BIGIP> "rm -rf /var/config/rest/iapps/irule-versioner/data/*"

# 2. Restart restnoded — onStart will see an empty data dir and re-baseline
ssh root@<BIGIP> "bigstart restart restnoded"

# 3. Watch for completion
ssh root@<BIGIP> "tail -f /var/log/restnoded/restnoded.log | grep irule-versioner"
# Wait for: RulesWorker.onStart: baseline complete, N rules snapshotted
```

**Warning:** deleting the data directory removes all version history, audit
log entries, and stored snapshots. This is destructive and permanent. If you
only want to add missing rules without losing existing history, use the manual
snapshot endpoint instead:

```bash
# Snapshot a specific rule that's missing from the store
curl -sk -u admin:$BIGIP_PASS \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"message": "Manual baseline", "author": "admin"}' \
  "https://<BIGIP>/mgmt/shared/irule-versioner/rules/Common/my_new_rule/snapshot"
```

The poll worker also auto-baselines any newly discovered rule (a rule present
on the system but not yet in the version store) on its next cycle, so in
normal operation missing rules are picked up within the configured poll interval.

---

## Development workflow

For fast iteration without rebuilding the RPM, copy individual files directly
to the running package directory and restart restnoded:

```bash
# Copy a changed file
scp nodejs/lib/rulesWorker.js root@<BIGIP>:/var/config/rest/iapps/irule-versioner/nodejs/lib/

# Restart restnoded to pick it up
ssh root@<BIGIP> "bigstart restart restnoded"

# Watch logs
ssh root@<BIGIP> "tail -f /var/log/restnoded/restnoded.log | grep irule-versioner"
```

Changes to `presentation/` (HTML/CSS/JS) do **not** require a restnoded
restart — they are served as static files.

---

## REST API reference

All endpoints are under `/mgmt/shared/irule-versioner/`.
Authentication uses the existing BIG-IP admin session cookie or basic auth.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rules` | List all iRules — status, hash, version count, drift flag |
| GET | `/rules/:partition/:name/versions` | Version history for one rule |
| GET | `/rules/:partition/:name/versions/:hash` | TCL content of a specific version |
| POST | `/rules/:partition/:name/snapshot` | Manual snapshot `{ message, author }` |
| POST | `/rules/:partition/:name/deploy` | Deploy a version `{ hash, reason, author }` |
| GET | `/rules/:partition/:name/diff?from=:hash&to=:hash` | Side-by-side line diff |
| GET | `/settings` | Read global settings |
| PUT | `/settings` | Update global settings |

**Example — list all rules:**
```bash
curl -sk -u admin:$BIGIP_PASS https://<BIGIP>/mgmt/shared/irule-versioner/rules
```

**Example — version history:**
```bash
curl -sk -u admin:$BIGIP_PASS \
  https://<BIGIP>/mgmt/shared/irule-versioner/rules/Common/my_rule/versions
```

**Example — diff two versions:**
```bash
curl -sk -u admin:$BIGIP_PASS \
  "https://<BIGIP>/mgmt/shared/irule-versioner/rules/Common/my_rule/diff?from=a3f9c12&to=b2e1a09"
```

**Example — manual snapshot:**
```bash
curl -sk -u admin:$BIGIP_PASS \
  -X POST -H "Content-Type: application/json" \
  -d '{"message":"Pre-change snapshot","author":"admin"}' \
  https://<BIGIP>/mgmt/shared/irule-versioner/rules/Common/my_rule/snapshot
```

---

## Version store layout

```
/var/config/rest/iapps/irule-versioner/data/
  Common/
    my_rule/
      manifest.json     ← version history + retention policy
      a3f9c12.tcl       ← TCL content blob, keyed by short SHA-1 hash
      b2e1a09.tcl
  audit.jsonl           ← append-only audit log (JSON Lines)
  settings.json         ← persisted global settings
```

This directory is **not managed by the RPM** — it survives install, upgrade,
and uninstall unchanged. Delete it manually only if you want to wipe all history.

---

## Running unit tests

No BIG-IP, no npm install required — tests use Node.js built-ins only.

```bash
node test/unit.js
```

---

## Key design decisions

**iControl REST for reads, tmsh for writes** — iRule content is read via
`GET /mgmt/tm/ltm/rule` on localhost:8100, which returns the clean TCL body in
the `apiAnonymous` field with no tmsh metadata mixed in. Deployments use
`tmsh load sys config merge file` + `tmsh save sys config` — the battle-tested
path for pushing config changes that guarantees persistence across reboots.

**localhost:8100 authentication** — Requests to localhost:8100 with
`Authorization: Basic admin:` (empty password) are accepted by restjavad
without password validation. The username establishes identity for audit
purposes; the password is never checked on the localhost channel. No
credentials are stored anywhere in the extension.

**Content-addressed blob store** — Version blobs are stored as
`<7-char-sha1>.tcl` files. Identical content produces the same hash and is
automatically deduplicated — saving the same rule twice without changes
creates no new blob or manifest entry.

**Single-flight poll lock** — The poll worker uses a boolean flag to prevent
concurrent poll cycles from stacking up during BIG-IP failover or high load.

**No npm dependencies** — Only Node.js built-in modules are used (`fs`, `path`,
`crypto`, `child_process`, `http`). This avoids compatibility issues with the
Node.js 6.9.1 runtime embedded in TMOS 21.x and keeps the RPM small.
