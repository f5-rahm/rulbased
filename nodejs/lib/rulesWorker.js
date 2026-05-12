'use strict';

var versionStore = require('./versionStore');
var bigipClient = require('./bigipClient');
var logger = require('./logger');
var settings = require('./settings');
var notifier = require('./notifier');
var migrations = require('./migrations');
var fs = require('fs');
var path = require('path');

var WORKER_URI_PATH = 'shared/rulbased/rules';

// ---------------------------------------------------------------------------
// Async deploy task tracking — in-memory Map (keyed by taskId)
// ---------------------------------------------------------------------------
var _tasks = {};
var _taskSeq = 0;

// Per-rule deploy lock
var _deployLock = {};

/**
 * Rules Worker
 *
 * Registered base URI: /mgmt/shared/rulbased/rules
 *
 * Routes:
 *   GET  /rules                                  - list all tracked iRules
 *   GET  /rules/audit                            - global audit log
 *   GET  /rules/:partition/:name/versions        - version history
 *   GET  /rules/:partition/:name/versions/:hash  - single version content
 *   GET  /rules/:partition/:name/diff            - ?from=:hash&to=:hash
 *   GET  /rules/:partition/:name/deploy/status/:taskId
 *   POST /rules/:partition/:name/snapshot        - manual snapshot
 *   POST /rules/:partition/:name/deploy          - deploy { hash, reason, author }
 *   PUT  /rules/:partition/:name/retention       - update retention policy
 *   PUT  /rules/:partition/:name/acknowledge     - mark rule as acknowledged (clears NEW badge)
 *   POST /rules/acknowledge-all                  - bulk acknowledge all non-drifted rules (Phase 8)
 *   POST /rules/export                           - export data dir as tar.gz
 *   POST /rules/import                           - import tar.gz (base64 JSON)
 *   POST /rules/import/check                     - check for conflicts before import
 */
function RulesWorker() {
  this.WORKER_URI_PATH = WORKER_URI_PATH;
  this.isPublic = true;
  this.isPassThrough = true;
}

/**
 * onStart fires when restnoded loads this worker.
 * Single-argument form — (success) only.
 */
RulesWorker.prototype.onStart = function (success) {
  var self = this;
  var dataDir = '/var/config/rest/iapps/rulbased/data';

  self.logger.info('[Rülbased] RulesWorker.onStart: start');

  try {
    settings.load(dataDir);
  } catch (se) {
    self.logger.warning('[Rülbased] RulesWorker.onStart: settings.load error: ' + se.message);
  }

  try {
    versionStore.init(dataDir, function (initErr) {
      if (initErr) {
        self.logger.severe('[Rülbased] RulesWorker.onStart: versionStore.init failed: ' + initErr.message);
        return success();
      }

      self.logger.info('[Rülbased] RulesWorker.onStart: store initialised, running migrations');

      // Run schema migrations before anything else.
      // Migrations are idempotent; on a fresh install v0→v1 is a no-op
      // (no blobs to prune).  On existing installs it cleans up orphaned blobs.
      migrations.run(dataDir, settings, function (migErr) {
        if (migErr) {
          self.logger.warning('[Rülbased] RulesWorker.onStart: migration error (non-fatal): ' + migErr.message);
        }

        // Phase 9: clean up any orphaned validate rules from crashed workers
        _cleanupOrphanedValidateRules();

        // Check for existing partition subdirectories to decide whether to baseline
        var fsLocal = require('fs');
        var pathLocal = require('path');
        var hasManifest = false;

        try {
          var entries = fsLocal.readdirSync(dataDir);
          for (var e = 0; e < entries.length; e++) {
            var entry = entries[e];
            if (entry === 'audit.jsonl' || entry === 'settings.json') { continue; }
            var entryPath = pathLocal.join(dataDir, entry);
            try {
              if (fsLocal.statSync(entryPath).isDirectory()) {
                hasManifest = true;
                break;
              }
            } catch (se2) { /* skip */ }
          }
        } catch (rdErr) {
          self.logger.warning('[Rülbased] RulesWorker.onStart: could not read data dir: ' + rdErr.message);
        }

        if (hasManifest) {
          self.logger.info('[Rülbased] RulesWorker.onStart: existing data found, skipping baseline');
          _startPollWorker(self, dataDir);
          return success();
        }

        self.logger.info('[Rülbased] RulesWorker.onStart: no existing data, running baseline');
        bigipClient.listAllRules(function (listErr, liveRules) {
          if (listErr) {
            self.logger.severe('[Rülbased] RulesWorker.onStart: listAllRules failed: ' + listErr.message);
            _startPollWorker(self, dataDir);
            return success();
          }
          var ruleCount = Object.keys(liveRules).length;
          self.logger.info('[Rülbased] RulesWorker.onStart: got ' + ruleCount + ' rules, snapshotting');
          var skipSystem = settings.getAll().hideSystemRules !== false;
          versionStore.baselineSnapshot(liveRules, dataDir, { skipSystem: skipSystem }, function (snapErr, count) {
            if (snapErr) {
              self.logger.severe('[Rülbased] RulesWorker.onStart: baseline failed: ' + snapErr.message);
            } else {
              self.logger.info('[Rülbased] RulesWorker.onStart: baseline complete, ' + count + ' rules snapshotted' +
                (skipSystem ? ' (F5 system rules excluded)' : ''));
            }
            _startPollWorker(self, dataDir);
            return success();
          });
        });
      });
    });
  } catch (e) {
    self.logger.severe('[Rülbased] RulesWorker.onStart: uncaught exception: ' + e.message);
    success();
  }
};

function _startPollWorker(workerInstance, dataDir) {
  var pollWorker = require('./pollWorker');
  try {
    var pollIntervalSeconds = settings.getAll().pollIntervalSeconds;
    if (!pollIntervalSeconds || pollIntervalSeconds <= 0) {
      workerInstance.logger.info('[Rülbased] RulesWorker.onStart: poll worker disabled (interval=0)');
      return;
    }
    pollWorker.start(dataDir, pollIntervalSeconds);
    workerInstance.logger.info('[Rülbased] RulesWorker.onStart: poll worker started, interval=' + pollIntervalSeconds + 's');
  } catch (e) {
    workerInstance.logger.warning('[Rülbased] RulesWorker.onStart: could not start poll worker: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------
RulesWorker.prototype.onGet = function (restOperation) {
  var segments = _getSegments(restOperation);
  var uri = restOperation.getUri();
  var dataDir = settings.getDataDir();

  logger.info('RulesWorker.onGet segments=' + JSON.stringify(segments) +
    ' uri=' + (uri ? uri.pathname : 'null'));

  // GET /rules
  if (segments.length === 0) {
    return _listRules(dataDir, restOperation);
  }

  // GET /rules/audit
  if (segments.length === 1 && segments[0] === 'audit') {
    var params = _extractQuery(uri);
    return _getAudit(dataDir, params, restOperation);
  }

  // GET /rules/:partition/:name/versions
  if (segments.length === 3 && segments[2] === 'versions') {
    return _listVersions(dataDir, segments[0], segments[1], restOperation);
  }

  // GET /rules/:partition/:name/versions/:hash
  if (segments.length === 4 && segments[2] === 'versions') {
    return _getVersionContent(dataDir, segments[0], segments[1], segments[3], restOperation);
  }

  // GET /rules/:partition/:name/diff?from=x&to=y
  if (segments.length === 3 && segments[2] === 'diff') {
    var qparams = _extractQuery(uri);
    return _getDiff(dataDir, segments[0], segments[1], qparams.from, qparams.to, restOperation);
  }

  // GET /rules/:partition/:name/deploy/status/:taskId
  if (segments.length === 5 && segments[2] === 'deploy' && segments[3] === 'status') {
    return _getDeployStatus(segments[4], restOperation);
  }

  _notFound(restOperation);
};

// ---------------------------------------------------------------------------
// PUT handler
// ---------------------------------------------------------------------------
RulesWorker.prototype.onPut = function (restOperation) {
  var segments = _getSegments(restOperation);
  var body = restOperation.getBody() || {};
  var dataDir = settings.getDataDir();

  logger.info('RulesWorker.onPut segments=' + JSON.stringify(segments));

  // PUT /rules/:partition/:name/retention
  if (segments.length === 3 && segments[2] === 'retention') {
    return _updateRetention(dataDir, segments[0], segments[1], body, restOperation);
  }

  // PUT /rules/:partition/:name/acknowledge
  if (segments.length === 3 && segments[2] === 'acknowledge') {
    return _acknowledgeRule(dataDir, segments[0], segments[1], restOperation);
  }

  _notFound(restOperation);
};

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------
RulesWorker.prototype.onPost = function (restOperation) {
  var segments = _getSegments(restOperation);
  var body = restOperation.getBody() || {};
  var dataDir = settings.getDataDir();

  logger.info('RulesWorker.onPost segments=' + JSON.stringify(segments));

  // POST /rules/validate
  if (segments.length === 1 && segments[0] === 'validate') {
    return _validateRule(body, restOperation);
  }

  // POST /rules/export
  if (segments.length === 1 && segments[0] === 'export') {
    return _exportData(dataDir, restOperation);
  }

  // POST /rules/acknowledge-all — bulk-acknowledge every non-drifted rule
  if (segments.length === 1 && segments[0] === 'acknowledge-all') {
    return _acknowledgeAll(dataDir, body, restOperation);
  }

  // POST /rules/import/check  — must be tested before /import
  if (segments.length === 2 && segments[0] === 'import' && segments[1] === 'check') {
    return _importCheck(dataDir, body, restOperation);
  }

  // POST /rules/import
  if (segments.length === 1 && segments[0] === 'import') {
    return _importData(dataDir, body, restOperation);
  }

  // POST /rules/:partition/:name/snapshot
  if (segments.length === 3 && segments[2] === 'snapshot') {
    return _manualSnapshot(dataDir, segments[0], segments[1], body, restOperation);
  }

  // POST /rules/:partition/:name/deploy
  if (segments.length === 3 && segments[2] === 'deploy') {
    return _deployVersion(dataDir, segments[0], segments[1], body, restOperation);
  }

  _notFound(restOperation);
};

// ---------------------------------------------------------------------------
// DELETE handler
// ---------------------------------------------------------------------------
RulesWorker.prototype.onDelete = function (restOperation) {
  var segments = _getSegments(restOperation);
  var dataDir  = settings.getDataDir();

  logger.info('RulesWorker.onDelete segments=' + JSON.stringify(segments));

  // DELETE /rules/:partition/:name  — remove rule from version store
  if (segments.length === 2) {
    return _deleteRuleFromStore(dataDir, segments[0], segments[1], restOperation);
  }

  _notFound(restOperation);
};

// ---------------------------------------------------------------------------
// URI parsing helper
// ---------------------------------------------------------------------------
function _getSegments(restOperation) {
  var uri = restOperation.getUri();
  var pathname = uri ? (uri.pathname || '') : '';

  var prefixes = [
    '/mgmt/shared/rulbased/rules',
    '/shared/rulbased/rules'
  ];

  var relative = pathname;
  for (var i = 0; i < prefixes.length; i++) {
    if (pathname.indexOf(prefixes[i]) === 0) {
      relative = pathname.slice(prefixes[i].length);
      break;
    }
  }

  return relative.replace(/^\/+/, '').split('/').filter(function (s) {
    return s.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Private route handlers
// ---------------------------------------------------------------------------

function _listRules(dataDir, restOperation) {
  bigipClient.listAllRules(function (err, liveRules) {
    if (err) {
      return _error(restOperation, 500, 'tmsh list failed: ' + err.message);
    }
    versionStore.listRules(dataDir, liveRules, function (storeErr, ruleList) {
      if (storeErr) {
        return _error(restOperation, 500, 'store read failed: ' + storeErr.message);
      }
      var hideSys = settings.getAll().hideSystemRules !== false;
      var hiddenCount = 0;
      var filtered = ruleList;
      if (hideSys) {
        filtered = [];
        for (var i = 0; i < ruleList.length; i++) {
          var r = ruleList[i];
          var live = liveRules[r.fullPath];
          var content = live ? live.content : '';
          if (versionStore.isSystemRule(r.name, content)) {
            hiddenCount++;
          } else {
            filtered.push(r);
          }
        }
      }
      restOperation.setStatusCode(200);
      restOperation.setBody({ items: filtered, systemRulesHidden: hiddenCount });
      restOperation.complete();
    });
  });
}

function _listVersions(dataDir, partition, name, restOperation) {
  versionStore.getManifest(dataDir, partition, name, function (err, manifest) {
    if (err) {
      return _error(restOperation, 404,
        'iRule not found in version store: ' + partition + '/' + name);
    }
    restOperation.setStatusCode(200);
    restOperation.setBody({ versions: manifest.versions });
    restOperation.complete();
  });
}

function _getVersionContent(dataDir, partition, name, hash, restOperation) {
  versionStore.getVersionContent(dataDir, partition, name, hash, function (err, content) {
    if (err) {
      return _error(restOperation, 404, 'Version not found: ' + hash);
    }
    restOperation.setStatusCode(200);
    restOperation.setBody({ hash: hash, content: content });
    restOperation.complete();
  });
}

function _getDiff(dataDir, partition, name, fromHash, toHash, restOperation) {
  if (!fromHash || !toHash) {
    return _error(restOperation, 400, 'from and to query params are required');
  }
  versionStore.getVersionContent(dataDir, partition, name, fromHash, function (err, fromContent) {
    if (err) { return _error(restOperation, 404, 'Version not found: ' + fromHash); }
    versionStore.getVersionContent(dataDir, partition, name, toHash, function (err2, toContent) {
      if (err2) { return _error(restOperation, 404, 'Version not found: ' + toHash); }
      var diff = _computeDiff(fromContent, toContent);
      restOperation.setStatusCode(200);
      restOperation.setBody({ from: fromHash, to: toHash, diff: diff });
      restOperation.complete();
    });
  });
}

function _manualSnapshot(dataDir, partition, name, body, restOperation) {
  var message = body.message || 'Manual snapshot';
  var author  = body.author  || 'unknown';

  if (body.content && typeof body.content === 'string' && body.content.trim().length > 0) {
    var content = body.content;

    bigipClient.deployRule(partition, name, content, function (deployErr) {
      if (deployErr) {
        // Return 200 with ok:false so restnoded doesn't intercept/wrap the body.
        // The GUI checks data.ok and surfaces data.error as the TCL message.
        restOperation.setStatusCode(200);
        restOperation.setBody({ ok: false, error: deployErr.message });
        restOperation.complete();
        return;
      }

      versionStore.saveVersion(dataDir, partition, name, content,
        message, author, 'manual', function (saveErr, version) {
          if (saveErr) {
            return _error(restOperation, 500, 'Failed to save version: ' + saveErr.message);
          }

          var auditEntry = {
            ts:     new Date().toISOString(),
            author: author,
            action: 'deploy',
            rule:   '/' + partition + '/' + name,
            toHash: version ? version.hash : null,
            reason: message
          };
          versionStore.appendAudit(dataDir, auditEntry, function () {
            notifier.emit({
              action:    'deploy',
              rule:      '/' + partition + '/' + name,
              fromHash:  null,
              toHash:    version ? version.hash : null,
              author:    author,
              reason:    message,
              timestamp: auditEntry.ts
            }, dataDir, versionStore.appendAudit);
            restOperation.setStatusCode(201);
            restOperation.setBody({ version: version, deployed: true });
            restOperation.complete();
          });
        });
    });
    return;
  }

  bigipClient.getRuleContent(partition, name, function (err, content) {
    if (err) {
      return _error(restOperation, 404,
        'iRule not found on system: ' + partition + '/' + name);
    }
    versionStore.saveVersion(dataDir, partition, name, content,
      message, author, 'manual', function (saveErr, version) {
        if (saveErr) {
          return _error(restOperation, 500, 'Failed to save version: ' + saveErr.message);
        }
        restOperation.setStatusCode(201);
        restOperation.setBody({ version: version, deployed: false });
        restOperation.complete();
      });
  });
}

function _getDeployStatus(taskId, restOperation) {
  var task = _tasks[taskId];
  if (!task) {
    return _error(restOperation, 404, 'Task not found: ' + taskId);
  }
  restOperation.setStatusCode(200);
  restOperation.setBody(task);
  restOperation.complete();
}

function _getAudit(dataDir, params, restOperation) {
  var auditFile = path.join(dataDir, 'audit.jsonl');
  var ruleFilter = params.rule || null;
  var limit = Math.min(parseInt(params.limit, 10) || 25, 200);
  var offset = parseInt(params.offset, 10) || 0;

  fs.readFile(auditFile, { encoding: 'utf8' }, function (err, data) {
    if (err) {
      restOperation.setStatusCode(200);
      restOperation.setBody({ items: [], total: 0, limit: limit, offset: offset });
      restOperation.complete();
      return;
    }
    var lines = (data || '').split('\n').filter(function (l) { return l.trim().length > 0; });
    var entries = [];
    lines.forEach(function (line) {
      try {
        var entry = JSON.parse(line);
        if (!ruleFilter || entry.rule === ruleFilter) { entries.push(entry); }
      } catch (pe) { /* skip malformed lines */ }
    });
    entries.reverse();
    restOperation.setStatusCode(200);
    restOperation.setBody({ items: entries.slice(offset, offset + limit), total: entries.length, limit: limit, offset: offset });
    restOperation.complete();
  });
}

function _updateRetention(dataDir, partition, name, body, restOperation) {
  var policy = body.policy;
  var max = body.max !== undefined ? body.max : null;
  var validPolicies = ['unlimited', 'count', 'age'];
  if (!policy || validPolicies.indexOf(policy) === -1) {
    return _error(restOperation, 400, 'retention.policy must be one of: ' + validPolicies.join(', '));
  }
  if ((policy === 'count' || policy === 'age') && (max === null || isNaN(parseInt(max, 10)))) {
    return _error(restOperation, 400, 'retention.max is required for policy=' + policy);
  }
  versionStore.getManifest(dataDir, partition, name, function (err, manifest) {
    if (err) {
      return _error(restOperation, 404, 'iRule not found in version store: ' + partition + '/' + name);
    }
    manifest.retention = {
      policy: policy,
      max: (policy === 'unlimited') ? null : parseInt(max, 10)
    };
    var safeName = name.replace(/\//g, '_');
    var manifestFile = path.join(dataDir, partition, safeName, 'manifest.json');
    fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), { encoding: 'utf8' }, function (writeErr) {
      if (writeErr) {
        return _error(restOperation, 500, 'Failed to save retention policy: ' + writeErr.message);
      }
      restOperation.setStatusCode(200);
      restOperation.setBody({ retention: manifest.retention });
      restOperation.complete();
    });
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function _exportData(dataDir, restOperation) {
  var backupDir = '/shared/rulbased-backups';
  var ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  var filename = 'rulbased-data-' + ts + '.tar.gz';

  // Write to /var/tmp first — always writable on BIG-IP, no mkdir needed.
  // After success we do a best-effort copy to backupDir for on-device retention.
  var tmpPath = '/var/tmp/' + filename;

  logger.info('RulesWorker._exportData: creating archive at ' + tmpPath);

  // Pre-check backup dir existence and writability.  restnoded runs as uid
  // 198 and cannot create top-level dirs under /shared (root:root 0755),
  // so if the dir is missing we flag the response and skip the on-device
  // copy entirely rather than logging noisy EACCES errors every time.
  // The dir is normally created by the RPM %post scriptlet — if it's
  // missing, the operator needs to run build/post-install.sh.
  var backupDirAvailable = false;
  try {
    var s = fs.statSync(backupDir);
    if (s && s.isDirectory()) { backupDirAvailable = true; }
  } catch (e) {
    logger.warning('RulesWorker._exportData: backup dir missing — on-device copy disabled. ' +
      'Run build/post-install.sh to create ' + backupDir + '. (stat: ' + e.message + ')');
  }

  versionStore.exportArchive(dataDir, tmpPath, function (tarErr) {
    if (tarErr) {
      return _error(restOperation, 500, tarErr.message);
    }

    fs.readFile(tmpPath, function (readErr, buf) {
      if (readErr) {
        fs.unlink(tmpPath, function () {});
        return _error(restOperation, 500, 'Archive created but could not be read: ' + readErr.message);
      }

      var b64 = buf.toString('base64');
      logger.info('RulesWorker._exportData: archive ' + buf.length + ' bytes');

      // Build response.  `devicePath` is the path the copy WILL land at if
      // the on-device backup dir exists; `devicePathSaved` tells the GUI
      // whether the on-device copy actually succeeded.  The browser download
      // always works regardless — the on-device copy is best-effort.
      var backupPath = path.join(backupDir, filename);
      var response = {
        filename: filename,
        data: b64,
        size: buf.length,
        path: backupDir + '/' + filename,
        devicePath: backupPath,
        devicePathSaved: false,
        devicePathError: null
      };

      if (!backupDirAvailable) {
        response.devicePathError = 'Backup directory ' + backupDir +
          ' does not exist. Run build/post-install.sh on the BIG-IP as root to create it.';
        // Respond immediately and clean up the tmp file
        restOperation.setStatusCode(200);
        restOperation.setBody(response);
        restOperation.complete();
        fs.unlink(tmpPath, function () {});
        return;
      }

      // Respond immediately — don't block the download on the device copy
      restOperation.setStatusCode(200);
      restOperation.setBody(response);
      restOperation.complete();

      // Best-effort copy to backupDir; fire-and-forget after response is sent.
      // Strategy: rename tmpPath into place (atomic on same filesystem).
      // If rename fails (cross-device or EACCES), fall back to copy+unlink.
      fs.rename(tmpPath, backupPath, function (renameErr) {
        if (!renameErr) {
          logger.info('RulesWorker._exportData: saved on-device copy to ' + backupPath);
          return;
        }
        // rename failed - try copy then unlink
        logger.fine('RulesWorker._exportData: rename failed (' + renameErr.message + '), trying copy');
        fs.readFile(tmpPath, function (readErr2, buf2) {
          if (readErr2) {
            logger.warning('RulesWorker._exportData: could not read tmpPath for copy: ' + readErr2.message);
            fs.unlink(tmpPath, function () {});
            return;
          }
          fs.writeFile(backupPath, buf2, function (cpErr) {
            if (cpErr) {
              logger.warning('RulesWorker._exportData: could not save to ' + backupPath + ': ' + cpErr.message);
            } else {
              logger.info('RulesWorker._exportData: saved on-device copy to ' + backupPath);
            }
            fs.unlink(tmpPath, function () {});
          });
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Import — conflict check
// ---------------------------------------------------------------------------

function _importCheck(dataDir, body, restOperation) {
  if (!body || !body.data) {
    return _error(restOperation, 400, 'Request body must contain { "data": "<base64>" }');
  }

  var tmpArchive = '/tmp/.irv-import-check-' + Date.now() + '.tar.gz';
  var buf;
  try {
    buf = Buffer.from(body.data, 'base64');
  } catch (e) {
    return _error(restOperation, 400, 'Invalid base64 data: ' + e.message);
  }

  fs.writeFile(tmpArchive, buf, function (writeErr) {
    if (writeErr) {
      return _error(restOperation, 500, 'Could not write temp archive: ' + writeErr.message);
    }
    versionStore.checkImportConflicts(tmpArchive, dataDir, function (checkErr, result) {
      fs.unlink(tmpArchive, function () {});
      if (checkErr) {
        return _error(restOperation, 500, 'Conflict check failed: ' + checkErr.message);
      }
      restOperation.setStatusCode(200);
      restOperation.setBody(result);
      restOperation.complete();
    });
  });
}

// ---------------------------------------------------------------------------
// Import — execute
// ---------------------------------------------------------------------------

function _importData(dataDir, body, restOperation) {
  if (!body || !body.data) {
    return _error(restOperation, 400, 'Request body must contain { "data": "<base64>", "conflictMode": "merge"|"replace" }');
  }

  var conflictMode = body.conflictMode || 'merge';
  if (conflictMode !== 'merge' && conflictMode !== 'replace') {
    return _error(restOperation, 400, 'conflictMode must be "merge" or "replace"');
  }

  var tmpArchive = '/tmp/.irv-import-' + Date.now() + '.tar.gz';
  var buf;
  try {
    buf = Buffer.from(body.data, 'base64');
  } catch (e) {
    return _error(restOperation, 400, 'Invalid base64 data: ' + e.message);
  }

  logger.info('RulesWorker._importData: archive size=' + buf.length + ' conflictMode=' + conflictMode);

  fs.writeFile(tmpArchive, buf, function (writeErr) {
    if (writeErr) {
      return _error(restOperation, 500, 'Could not write temp archive: ' + writeErr.message);
    }
    versionStore.importArchive(tmpArchive, dataDir, conflictMode, function (importErr, report) {
      fs.unlink(tmpArchive, function () {});
      if (importErr) {
        return _error(restOperation, 500, 'Import failed: ' + importErr.message);
      }
      logger.info('RulesWorker._importData: complete — ' + JSON.stringify(report));
      // Append an audit entry recording the import
      var auditEntry = {
        ts: new Date().toISOString(),
        author: body.author || 'unknown',
        action: 'import',
        rule: null,
        reason: 'Imported archive (' + conflictMode + ' mode): ' +
          report.imported + ' new, ' + report.merged + ' merged, ' +
          report.replaced + ' replaced'
      };
      versionStore.appendAudit(dataDir, auditEntry, function () {});
      restOperation.setStatusCode(200);
      restOperation.setBody({ ok: true, report: report });
      restOperation.complete();
    });
  });
}

// ---------------------------------------------------------------------------
// Deploy helpers
// ---------------------------------------------------------------------------

function _finishTask(task, lockKey, errMsg, result) {
  delete _deployLock[lockKey];
  task.completedAt = new Date().toISOString();
  if (errMsg) {
    task.status = 'failed';
    task.error = errMsg;
    logger.severe('Deploy task ' + task.taskId + ' failed: ' + errMsg);
  } else {
    task.status = 'completed';
    task.result = result;
    logger.info('Deploy task ' + task.taskId + ' completed successfully');
  }
  var cutoff = Date.now() - 3600000;
  Object.keys(_tasks).forEach(function (id) {
    var t = _tasks[id];
    if (t.status !== 'running' && t.completedAt && new Date(t.completedAt).getTime() < cutoff) {
      delete _tasks[id];
    }
  });
}

function _deployVersion(dataDir, partition, name, body, restOperation) {
  var hash = body.hash;
  var reason = body.reason;

  if (!hash) {
    return _error(restOperation, 400, 'hash is required');
  }
  if (!reason || reason.trim().length === 0) {
    return _error(restOperation, 400, 'reason is required and must not be empty');
  }

  var author = body.author || 'unknown';
  var lockKey = '/' + partition + '/' + name;

  if (_deployLock[lockKey]) {
    return _error(restOperation, 409, 'A deploy is already in progress for ' + lockKey);
  }

  _taskSeq++;
  var taskId = 'task-' + _taskSeq + '-' + Date.now();
  var task = {
    taskId: taskId,
    status: 'running',
    rule: lockKey,
    hash: hash,
    author: author,
    reason: reason,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    result: null
  };
  _tasks[taskId] = task;
  _deployLock[lockKey] = true;

  restOperation.setStatusCode(202);
  restOperation.setBody({ taskId: taskId, status: 'running' });
  restOperation.complete();

  versionStore.getVersionContent(dataDir, partition, name, hash, function (err, content) {
    if (err) {
      return _finishTask(task, lockKey, 'Version not found: ' + hash, null);
    }
    bigipClient.getRuleContent(partition, name, function (liveErr, liveContent) {
      var preDeploy = function (next) {
        if (liveErr || !liveContent) { return next(); }
        versionStore.saveVersion(dataDir, partition, name, liveContent,
          'Pre-deploy snapshot', author, 'pre-deploy', function () { next(); });
      };
      preDeploy(function () {
        bigipClient.deployRule(partition, name, content, function (deployErr) {
          if (deployErr) {
            return _finishTask(task, lockKey, 'deploy failed: ' + deployErr.message, null);
          }
          versionStore.saveVersion(dataDir, partition, name, content,
            reason, author, 'tool-deploy', function (saveErr, version) {
              if (saveErr) { logger.warning('Deploy succeeded but post-deploy snapshot failed: ' + saveErr.message); }
              var auditEntry = {
                ts: new Date().toISOString(),
                author: author,
                action: 'deploy',
                rule: lockKey,
                toHash: hash,
                reason: reason
              };
              versionStore.appendAudit(dataDir, auditEntry, function () {
                notifier.emit({
                  action:    auditEntry.action,
                  rule:      lockKey,
                  fromHash:  null,
                  toHash:    hash,
                  author:    author,
                  reason:    reason,
                  timestamp: auditEntry.ts
                }, dataDir, versionStore.appendAudit);
                _finishTask(task, lockKey, null, { deployed: hash, version: version || null, audit: auditEntry });
              });
            });
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Acknowledge rule (clear "new" state)
// ---------------------------------------------------------------------------

function _acknowledgeRule(dataDir, partition, name, restOperation) {
  versionStore.acknowledgeRule(dataDir, partition, name, function (err) {
    if (err) {
      return _error(restOperation, 404,
        'Rule not found in version store: ' + partition + '/' + name);
    }
    restOperation.setStatusCode(200);
    restOperation.setBody({ ok: true, acknowledged: true });
    restOperation.complete();
  });
}

// ---------------------------------------------------------------------------
// Acknowledge all (bulk clear "new" state)
// ---------------------------------------------------------------------------

function _acknowledgeAll(dataDir, body, restOperation) {
  var author = (body && body.author) || 'unknown';

  bigipClient.listAllRules(function (listErr, liveRules) {
    if (listErr) {
      // Don't hard-fail — acknowledge without drift detection.  Worst case,
      // a drifted rule gets acknowledged and the operator sees it turn back
      // to NEW on the next poll, which is safe.
      logger.warning('_acknowledgeAll: listAllRules failed, proceeding without drift check: ' + listErr.message);
      liveRules = {};
    }

    versionStore.acknowledgeAll(dataDir, liveRules, function (ackErr, report) {
      if (ackErr) {
        return _error(restOperation, 500, 'acknowledge-all failed: ' + ackErr.message);
      }

      // Single audit entry for the whole operation (per PLANNING.md §Phase 8)
      if (report.acknowledged > 0) {
        var auditEntry = {
          ts: new Date().toISOString(),
          author: author,
          action: 'acknowledge-all',
          rule: null,
          reason: 'Bulk acknowledged ' + report.acknowledged + ' rule(s); ' +
            'skipped ' + report.skippedDrift + ' drifted, ' +
            report.skippedNoVersions + ' without versions'
        };
        versionStore.appendAudit(dataDir, auditEntry, function () {});
      }

      logger.info('_acknowledgeAll: ' + JSON.stringify(report));
      restOperation.setStatusCode(200);
      restOperation.setBody({ ok: true, report: report });
      restOperation.complete();
    });
  });
}

// ---------------------------------------------------------------------------
// Delete rule from store
// ---------------------------------------------------------------------------

function _deleteRuleFromStore(dataDir, partition, name, restOperation) {
  var childProcess = require('child_process');
  var safeName = name.replace(/\//g, '_');
  var ruleDir = require('path').join(dataDir, partition, safeName);

  logger.info('RulesWorker._deleteRuleFromStore: ' + partition + '/' + name + ' -> ' + ruleDir);

  // Verify it exists before attempting removal
  var fs = require('fs');
  fs.access(ruleDir, fs.F_OK, function (accessErr) {
    if (accessErr) {
      return _error(restOperation, 404,
        'Rule not found in version store: ' + partition + '/' + name);
    }

    // Use rm -rf via child_process — Node 6 has no recursive rmdir
    childProcess.execFile('/bin/rm', ['-rf', ruleDir], { timeout: 15000 },
      function (rmErr, stdout, stderr) {
        if (rmErr) {
          logger.severe('_deleteRuleFromStore: rm failed: ' + (stderr || rmErr.message));
          return _error(restOperation, 500,
            'Failed to remove rule directory: ' + (stderr || rmErr.message));
        }

        // Append audit entry
        var auditEntry = {
          ts:     new Date().toISOString(),
          author: 'admin',
          action: 'store-delete',
          rule:   '/' + partition + '/' + name,
          reason: 'Removed from version store via UI'
        };
        versionStore.appendAudit(dataDir, auditEntry, function () {});

        logger.info('_deleteRuleFromStore: removed ' + ruleDir);
        restOperation.setStatusCode(200);
        restOperation.setBody({ ok: true, removed: '/' + partition + '/' + name });
        restOperation.complete();
      });
  });
}

// ---------------------------------------------------------------------------
// Diff utility
// ---------------------------------------------------------------------------
function _computeDiff(oldText, newText) {
  var oldLines = (oldText || '').split('\n');
  var newLines = (newText || '').split('\n');
  var result = [];
  var lcs = _lcs(oldLines, newLines);
  var oi = 0, ni = 0, li = 0;

  while (li < lcs.length) {
    while (oi < lcs[li].oldIdx) {
      result.push({ type: 'delete', left: oldLines[oi], right: null });
      oi++;
    }
    while (ni < lcs[li].newIdx) {
      result.push({ type: 'insert', left: null, right: newLines[ni] });
      ni++;
    }
    result.push({ type: 'equal', left: oldLines[oi], right: newLines[ni] });
    oi++; ni++; li++;
  }
  while (oi < oldLines.length) {
    result.push({ type: 'delete', left: oldLines[oi], right: null });
    oi++;
  }
  while (ni < newLines.length) {
    result.push({ type: 'insert', left: null, right: newLines[ni] });
    ni++;
  }
  return result;
}

function _lcs(a, b) {
  var m = a.length, n = b.length;
  var dp = [], i, j;
  for (i = 0; i <= m; i++) {
    dp[i] = [];
    for (j = 0; j <= n; j++) { dp[i][j] = 0; }
  }
  for (i = 1; i <= m; i++) {
    for (j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  var result = [];
  i = m; j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift({ oldIdx: i - 1, newIdx: j - 1 });
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _extractQuery(uri) {
  if (!uri) { return {}; }
  var q = uri.query;
  if (q && typeof q === 'object') { return q; }
  if (!q || typeof q !== 'string') { return {}; }
  var result = {};
  q.replace(/^\?/, '').split('&').forEach(function (pair) {
    var parts = pair.split('=');
    if (parts[0]) {
      result[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Pre-flight validation (Phase 9.2b)
// ---------------------------------------------------------------------------
function _validateRule(body, restOperation) {
  var content = body.content;
  if (!content || typeof content !== 'string' || !content.trim()) {
    return _error(restOperation, 400, 'content is required');
  }

  var partition = body.partition || 'Common';
  var ts = Date.now();
  var rand = Math.floor(Math.random() * 100000);
  var tmpName = '_rulbased_validate_' + ts + '_' + rand;

  logger.info('_validateRule: creating throwaway rule ' + partition + '/' + tmpName);

  bigipClient.deployRule(partition, tmpName, content, function (deployErr) {
    _deleteThrowawayRule(partition, tmpName, function () {
      restOperation.setStatusCode(200);
      if (deployErr) {
        restOperation.setBody({ ok: false, error: deployErr.message, lintWarnings: [] });
      } else {
        restOperation.setBody({ ok: true, error: null, lintWarnings: [] });
      }
      restOperation.complete();
    });
  });
}

function _deleteThrowawayRule(partition, name, cb) {
  var bashBody = {
    command: 'run',
    utilCmdArgs: "-c 'tmsh delete ltm rule /" + partition + "/" + name + "'"
  };
  var attempts = 0;
  var maxAttempts = 3;

  function tryDelete() {
    attempts++;
    bigipClient._post('/mgmt/tm/util/bash', bashBody, function (err) {
      if (err && attempts < maxAttempts) {
        setTimeout(tryDelete, 1000);
        return;
      }
      if (err) {
        logger.warning('_deleteThrowawayRule: failed to delete ' +
          partition + '/' + name + ' after ' + maxAttempts + ' attempts: ' + err.message);
      }
      cb();
    });
  }
  tryDelete();
}

function _cleanupOrphanedValidateRules() {
  bigipClient.listAllRules(function (err, rules) {
    if (err) { return; }
    var cutoff = Date.now() - 600000; // 10 minutes
    var keys = Object.keys(rules);
    for (var i = 0; i < keys.length; i++) {
      var rule = rules[keys[i]];
      if (rule.name.indexOf('_rulbased_validate_') !== 0) { continue; }
      var parts = rule.name.split('_');
      // Name format: _rulbased_validate_<ts>_<rand>
      var ts = parseInt(parts[3], 10);
      if (isNaN(ts) || ts < cutoff) {
        logger.info('Cleaning up orphaned validate rule: ' + rule.fullPath);
        _deleteThrowawayRule(rule.partition, rule.name, function () {});
      }
    }
  });
}

function _error(restOperation, code, message) {
  logger.severe('RulesWorker error ' + code + ': ' + message);
  restOperation.setStatusCode(code);
  restOperation.setBody({ error: message });
  restOperation.complete();
}

function _notFound(restOperation) {
  _error(restOperation, 404, 'Not found');
}

module.exports = RulesWorker;
