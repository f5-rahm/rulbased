'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var logger = require('./logger');

/**
 * versionStore.js
 *
 * Manages the local filesystem version store.
 *
 * Directory layout under dataDir:
 *
 *   dataDir/
 *     Common/
 *       my_rule/
 *         manifest.json       <- version history + metadata
 *         a3f9c12.tcl         <- content blob keyed by short hash
 *         b2e1a09.tcl
 *     audit.jsonl             <- append-only audit log (JSON Lines)
 *     settings.json           <- persisted global settings
 */

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Ensure the data directory and top-level files exist.
 * Safe to call multiple times (idempotent).
 */
function init(dataDir, cb) {
  _mkdirp(dataDir, function (err) {
    if (err) { return cb(err); }
    var auditFile = path.join(dataDir, 'audit.jsonl');
    fs.access(auditFile, fs.F_OK, function (accessErr) {
      if (accessErr) {
        fs.writeFile(auditFile, '', function (writeErr) {
          cb(writeErr || null);
        });
      } else {
        cb(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Baseline snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot all iRules in the provided map. Only creates a new version entry
 * if no manifest exists yet for that rule (first-run baseline).
 *
 * @param {object}   rules    - map from tmsh.listAllRules
 * @param {string}   dataDir
 * @param {function} cb       - cb(err, count)
 */
function baselineSnapshot(rules, dataDir, cb) {
  var ruleKeys = Object.keys(rules);
  var count = 0;
  var idx = 0;

  function next() {
    if (idx >= ruleKeys.length) { return cb(null, count); }
    var rule = rules[ruleKeys[idx]];
    idx++;

    var manifestPath = _manifestPath(dataDir, rule.partition, rule.name);
    fs.access(manifestPath, fs.F_OK, function (err) {
      if (!err) {
        // Manifest already exists — skip (don't overwrite existing history)
        return next();
      }
      // No manifest — create baseline
      saveVersion(dataDir, rule.partition, rule.name, rule.content,
        'Baseline snapshot', 'system', 'baseline', function (saveErr) {
          if (saveErr) {
            logger.warn('baselineSnapshot: failed for ' + rule.fullPath + ': ' + saveErr.message);
          } else {
            count++;
          }
          next();
        });
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// Save version
// ---------------------------------------------------------------------------

/**
 * Save a new version of an iRule.
 * Computes a short SHA-1 hash of the content; deduplicates if the content
 * is identical to the most recent version.
 *
 * @param {string}   dataDir
 * @param {string}   partition
 * @param {string}   name
 * @param {string}   content   - raw TCL body
 * @param {string}   message   - commit message
 * @param {string}   author    - BIG-IP username or 'system'
 * @param {string}   source    - 'baseline'|'manual'|'tool-deploy'|'pre-deploy'|'external-poll'
 * @param {function} cb        - cb(err, versionEntry)
 */
function saveVersion(dataDir, partition, name, content, message, author, source, cb) {
  var hash = _shortHash(content);
  var ruleDir = _ruleDir(dataDir, partition, name);

  _mkdirp(ruleDir, function (mkErr) {
    if (mkErr) { return cb(mkErr); }

    _loadManifest(dataDir, partition, name, function (loadErr, manifest) {
      if (loadErr) {
        // First version for this rule
        manifest = _newManifest(partition, name);
      }

      // Deduplicate: if most recent version has the same hash, skip
      if (manifest.versions.length > 0 &&
          manifest.versions[manifest.versions.length - 1].hash === hash) {
        logger.debug('saveVersion: no change for ' + partition + '/' + name + ' (hash=' + hash + ')');
        return cb(null, manifest.versions[manifest.versions.length - 1]);
      }

      var blobPath = path.join(ruleDir, hash + '.tcl');
      fs.writeFile(blobPath, content, { encoding: 'utf8' }, function (blobErr) {
        if (blobErr) { return cb(blobErr); }

        var entry = {
          hash: hash,
          timestamp: new Date().toISOString(),
          author: author,
          message: message,
          source: source,
          blobFile: hash + '.tcl'
        };

        manifest.versions.push(entry);
        _applyRetention(manifest);

        _saveManifest(dataDir, partition, name, manifest, function (saveErr) {
          if (saveErr) { return cb(saveErr); }
          cb(null, entry);
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * List all tracked iRules, merged with live system state.
 * Returns an array of rule summary objects for the GUI list panel.
 */
function listRules(dataDir, liveRules, cb) {
  // Walk the data directory to find all manifests
  _walkManifests(dataDir, function (walkErr, manifests) {
    if (walkErr) { return cb(walkErr); }

    var liveKeys = Object.keys(liveRules);

    // Build the result list: one entry per rule seen in live system OR store
    var seen = {};
    var result = [];

    manifests.forEach(function (m) {
      var key = '/' + m.partition + '/' + m.name;
      seen[key] = true;
      var latest = m.versions.length ? m.versions[m.versions.length - 1] : null;
      var liveRule = liveRules[key];
      var drifted = false;

      if (liveRule && latest) {
        var liveHash = _shortHash(liveRule.content);
        drifted = (liveHash !== latest.hash);
      }

      result.push({
        partition: m.partition,
        name: m.name,
        fullPath: key,
        versionCount: m.versions.length,
        latestHash: latest ? latest.hash : null,
        latestTimestamp: latest ? latest.timestamp : null,
        latestMessage: latest ? latest.message : null,
        latestAuthor: latest ? latest.author : null,
        drifted: drifted,
        retention: m.retention,
        inVersionStore: true,
        onSystem: !!liveRule
      });
    });

    // Add live rules not yet in the store (edge case: rules added between polls)
    liveKeys.forEach(function (key) {
      if (!seen[key]) {
        var r = liveRules[key];
        result.push({
          partition: r.partition,
          name: r.name,
          fullPath: key,
          versionCount: 0,
          latestHash: null,
          latestTimestamp: null,
          latestMessage: null,
          latestAuthor: null,
          drifted: false,
          retention: null,
          inVersionStore: false,
          onSystem: true
        });
      }
    });

    result.sort(function (a, b) { return a.fullPath.localeCompare(b.fullPath); });
    cb(null, result);
  });
}

/**
 * Get the manifest for a specific rule.
 */
function getManifest(dataDir, partition, name, cb) {
  _loadManifest(dataDir, partition, name, cb);
}

/**
 * Get the TCL content of a specific version by hash.
 */
function getVersionContent(dataDir, partition, name, hash, cb) {
  var blobPath = path.join(_ruleDir(dataDir, partition, name), hash + '.tcl');
  fs.readFile(blobPath, { encoding: 'utf8' }, function (err, content) {
    if (err) { return cb(new Error('Blob not found: ' + hash)); }
    cb(null, content);
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function appendAudit(dataDir, entry, cb) {
  var auditFile = path.join(dataDir, 'audit.jsonl');
  var line = JSON.stringify(entry) + '\n';
  fs.appendFile(auditFile, line, function (err) {
    if (err) { logger.warn('appendAudit failed: ' + err.message); }
    if (cb) { cb(null); }
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _shortHash(content) {
  return crypto.createHash('sha1').update(content || '').digest('hex').slice(0, 7);
}

function _ruleDir(dataDir, partition, name) {
  return path.join(dataDir, partition, name.replace(/\//g, '_'));
}

function _manifestPath(dataDir, partition, name) {
  return path.join(_ruleDir(dataDir, partition, name), 'manifest.json');
}

function _newManifest(partition, name) {
  return {
    partition: partition,
    name: name,
    retention: { policy: 'unlimited', max: null },
    versions: []
  };
}

function _loadManifest(dataDir, partition, name, cb) {
  var p = _manifestPath(dataDir, partition, name);
  fs.readFile(p, { encoding: 'utf8' }, function (err, data) {
    if (err) { return cb(err); }
    try {
      cb(null, JSON.parse(data));
    } catch (e) {
      cb(new Error('Corrupt manifest: ' + p));
    }
  });
}

function _saveManifest(dataDir, partition, name, manifest, cb) {
  var p = _manifestPath(dataDir, partition, name);
  fs.writeFile(p, JSON.stringify(manifest, null, 2), { encoding: 'utf8' }, cb);
}

/**
 * Apply the retention policy to a manifest, removing old versions
 * and their blob files if necessary.
 * Called in-memory; does NOT clean up orphaned blobs (a separate
 * maintenance task handles that in a later phase).
 */
function _applyRetention(manifest) {
  var r = manifest.retention;
  if (!r || r.policy === 'unlimited' || !r.max) { return; }
  if (r.policy === 'count') {
    while (manifest.versions.length > r.max) {
      manifest.versions.shift();
    }
  }
}

/**
 * Walk the data directory and load all manifests.
 */
function _walkManifests(dataDir, cb) {
  var manifests = [];
  fs.readdir(dataDir, function (err, partitions) {
    if (err) { return cb(null, []); } // empty store is fine
    var pendingPartitions = partitions.filter(function (p) {
      // skip audit.jsonl, settings.json etc.
      return !p.endsWith('.jsonl') && !p.endsWith('.json');
    });
    if (pendingPartitions.length === 0) { return cb(null, []); }

    var done = 0;
    pendingPartitions.forEach(function (partition) {
      var partDir = path.join(dataDir, partition);
      fs.stat(partDir, function (statErr, stat) {
        if (statErr || !stat.isDirectory()) {
          done++;
          if (done === pendingPartitions.length) { cb(null, manifests); }
          return;
        }
        fs.readdir(partDir, function (rdErr, ruleDirs) {
          if (rdErr) {
            done++;
            if (done === pendingPartitions.length) { cb(null, manifests); }
            return;
          }
          var pendingRules = ruleDirs.length;
          if (pendingRules === 0) {
            done++;
            if (done === pendingPartitions.length) { cb(null, manifests); }
            return;
          }
          var rulesDone = 0;
          ruleDirs.forEach(function (ruleDir) {
            var mPath = path.join(partDir, ruleDir, 'manifest.json');
            fs.readFile(mPath, { encoding: 'utf8' }, function (mErr, data) {
              if (!mErr) {
                try { manifests.push(JSON.parse(data)); } catch (e) { /* skip corrupt */ }
              }
              rulesDone++;
              if (rulesDone === pendingRules) {
                done++;
                if (done === pendingPartitions.length) { cb(null, manifests); }
              }
            });
          });
        });
      });
    });
  });
}

function _mkdirp(dirPath, cb) {
  fs.mkdir(dirPath, { recursive: true }, function (err) {
    if (!err) { return cb(null); }
    if (err.code === 'EEXIST') { return cb(null); }
    // Older Node versions (TMOS restnoded) either throw ERR_INVALID_OPT_VALUE
    // when { recursive } is unrecognised, or ENOENT when they ignore the option
    // and try to create the leaf directory without creating parents first.
    // Both cases fall back to the manual recursive implementation.
    if (err.code === 'ERR_INVALID_OPT_VALUE' || err.code === 'ENOENT') {
      return _mkdirpLegacy(dirPath, cb);
    }
    cb(err);
  });
}

function _mkdirpLegacy(dirPath, cb) {
  var parts = dirPath.split(path.sep);
  var current = '';
  var idx = 0;
  function step() {
    if (idx >= parts.length) { return cb(null); }
    current = current ? path.join(current, parts[idx]) : parts[idx] || path.sep;
    idx++;
    fs.mkdir(current, function (err) {
      if (err && err.code !== 'EEXIST') { return cb(err); }
      step();
    });
  }
  step();
}

module.exports = {
  init: init,
  baselineSnapshot: baselineSnapshot,
  saveVersion: saveVersion,
  listRules: listRules,
  getManifest: getManifest,
  getVersionContent: getVersionContent,
  appendAudit: appendAudit
};
