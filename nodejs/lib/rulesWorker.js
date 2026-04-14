'use strict';

var versionStore = require('./versionStore');
var bigipClient = require('./bigipClient');
var tmsh = require('./tmsh');
var logger = require('./logger');
var settings = require('./settings');

var WORKER_URI_PATH = 'shared/irule-versioner/rules';

/**
 * Rules Worker
 *
 * Registered base URI: /mgmt/shared/irule-versioner/rules
 *
 * restnoded routes any request whose URI starts with the WORKER_URI_PATH
 * to this worker. The full pathname is available via restOperation.getUri().
 * We strip the base prefix to get the sub-path and route from there.
 *
 * However: restnoded may pass the URI in different forms depending on TMOS
 * version — with or without /mgmt prefix, with or without trailing slash.
 * The _getRelative() helper normalises all variants.
 *
 * Routes:
 *   GET  /rules                                - list all tracked iRules
 *   GET  /rules/:partition/:name/versions      - version history
 *   GET  /rules/:partition/:name/versions/:hash - single version TCL content
 *   GET  /rules/:partition/:name/diff          - ?from=:hash&to=:hash
 *   POST /rules/:partition/:name/snapshot      - manual snapshot
 *   POST /rules/:partition/:name/deploy        - deploy { hash, reason, author }
 */
function RulesWorker() {
  this.WORKER_URI_PATH = WORKER_URI_PATH;
  this.isPublic = true;
  this.isPassThrough = true;
}


/**
 * onStart fires when restnoded loads this worker — on every restart.
 * We use it to initialise the version store and run a baseline snapshot
 * if the data directory doesn't exist yet (first install).
 * Subsequent restarts skip the baseline since manifests already exist.
 */
/**
 * onStart fires when restnoded loads this worker.
 * Single-argument form — (success) only — the framework does NOT call
 * the function if it has two parameters.
 * Uses this.logger (injected by restnoded's RestWorker mixin) rather
 * than our custom logger module to avoid any initialisation ordering issue.
 */
RulesWorker.prototype.onStart = function (success) {
  var self = this;
  var dataDir = '/var/config/rest/iapps/irule-versioner/data';

  self.logger.info('[irule-versioner] RulesWorker.onStart: start');

  try {
    versionStore.init(dataDir, function (initErr) {
      if (initErr) {
        self.logger.severe('[irule-versioner] RulesWorker.onStart: versionStore.init failed: ' + initErr.message);
        return success();
      }

      self.logger.info('[irule-versioner] RulesWorker.onStart: store initialised, checking for existing data');

      // Check synchronously for existing partition subdirectories
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
          } catch (se) { /* skip */ }
        }
      } catch (rdErr) {
        self.logger.warning('[irule-versioner] RulesWorker.onStart: could not read data dir: ' + rdErr.message);
      }

      if (hasManifest) {
        self.logger.info('[irule-versioner] RulesWorker.onStart: existing data found, skipping baseline');
        _startPollWorker(self, dataDir);
        return success();
      }

      self.logger.info('[irule-versioner] RulesWorker.onStart: no existing data, running baseline');

      bigipClient.listAllRules(function (listErr, rules) {
        if (listErr) {
          self.logger.severe('[irule-versioner] RulesWorker.onStart: listAllRules failed: ' + listErr.message);
          return success();
        }

        var ruleCount = Object.keys(rules).length;
        self.logger.info('[irule-versioner] RulesWorker.onStart: got ' + ruleCount + ' rules, snapshotting');

        versionStore.baselineSnapshot(rules, dataDir, function (snapErr, count) {
          if (snapErr) {
            self.logger.severe('[irule-versioner] RulesWorker.onStart: baseline failed: ' + snapErr.message);
          } else {
            self.logger.info('[irule-versioner] RulesWorker.onStart: baseline complete, ' + count + ' rules snapshotted');
          }
          _startPollWorker(self, dataDir);
          success();
        });
      });
    });
  } catch (e) {
    self.logger.severe('[irule-versioner] RulesWorker.onStart: uncaught exception: ' + e.message);
    success();
  }
};

function _startPollWorker(workerInstance, dataDir) {
  try {
    var pollIntervalSeconds = 300;
    var pollWorker = require('./pollWorker');
    pollWorker.start(dataDir, pollIntervalSeconds);
    workerInstance.logger.info('[irule-versioner] RulesWorker.onStart: poll worker started, interval=' + pollIntervalSeconds + 's');
  } catch (e) {
    workerInstance.logger.warning('[irule-versioner] RulesWorker.onStart: could not start poll worker: ' + e.message);
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
    ' path=' + (uri ? uri.pathname : 'null'));

  // GET /rules  - list all iRules
  if (segments.length === 0) {
    return _listRules(dataDir, restOperation);
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
    var params = _extractQuery(uri);
    return _getDiff(dataDir, segments[0], segments[1], params.from, params.to, restOperation);
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
// URI parsing helper
// Strips the worker base path in all forms restnoded may present it:
//   /mgmt/shared/irule-versioner/rules/Common/my_rule/versions
//   /shared/irule-versioner/rules/Common/my_rule/versions
//   /Common/my_rule/versions   (already stripped by restnoded on some versions)
//   (empty string or just /)  -> root = list endpoint
// Returns a clean array of non-empty path segments after the base.
// ---------------------------------------------------------------------------
function _getSegments(restOperation) {
  var uri = restOperation.getUri();
  var pathname = uri ? (uri.pathname || '') : '';

  // Strip known prefixes - try longest first
  var prefixes = [
    '/mgmt/shared/irule-versioner/rules',
    '/shared/irule-versioner/rules'
  ];

  var relative = pathname;
  for (var i = 0; i < prefixes.length; i++) {
    if (pathname.indexOf(prefixes[i]) === 0) {
      relative = pathname.slice(prefixes[i].length);
      break;
    }
  }

  // Strip leading slash and split, filtering empty segments
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
      restOperation.setStatusCode(200);
      restOperation.setBody({ items: ruleList });
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
  var author = body.author || 'unknown';

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
        restOperation.setBody({ version: version });
        restOperation.complete();
      });
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

  versionStore.getVersionContent(dataDir, partition, name, hash, function (err, content) {
    if (err) {
      return _error(restOperation, 404, 'Version not found: ' + hash);
    }

    // Pre-deploy snapshot of current live state
    bigipClient.getRuleContent(partition, name, function (liveErr, liveContent) {
      var preDeploy = function (next) {
        if (liveErr || !liveContent) { return next(); }
        versionStore.saveVersion(dataDir, partition, name, liveContent,
          'Pre-deploy snapshot', author, 'pre-deploy', function () { next(); });
      };

      preDeploy(function () {
        tmsh.deployRule(partition, name, content, function (deployErr) {
          if (deployErr) {
            return _error(restOperation, 500, 'tmsh deploy failed: ' + deployErr.message);
          }

          versionStore.saveVersion(dataDir, partition, name, content,
            reason, author, 'tool-deploy', function (saveErr, version) {
              if (saveErr) {
                logger.warn('Deploy succeeded but post-deploy snapshot failed: ' +
                  saveErr.message);
              }

              var auditEntry = {
                ts: new Date().toISOString(),
                author: author,
                action: 'deploy',
                rule: '/' + partition + '/' + name,
                toHash: hash,
                reason: reason
              };

              versionStore.appendAudit(dataDir, auditEntry, function () {
                restOperation.setStatusCode(200);
                restOperation.setBody({
                  deployed: hash,
                  version: version,
                  audit: auditEntry
                });
                restOperation.complete();
              });
            });
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Diff utility - line-level LCS-based side-by-side diff
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
  // uri.query may be a pre-parsed object (TMOS) or a raw string — handle both
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

function _error(restOperation, code, message) {
  logger.error('RulesWorker error ' + code + ': ' + message);
  restOperation.setStatusCode(code);
  restOperation.setBody({ error: message });
  restOperation.complete();
}

function _notFound(restOperation) {
  _error(restOperation, 404, 'Not found');
}

module.exports = RulesWorker;
