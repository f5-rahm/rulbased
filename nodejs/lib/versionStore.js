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
 * Test whether a rule is an F5-shipped system iRule.
 *
 * Two conditions must both hold:
 *   1. name starts with "_sys_"   (F5 naming convention)
 *   2. body's first non-whitespace token is "nodelete nowrite"
 *      (the literal marker F5 embeds in apiAnonymous — TMOS strips this on
 *      write, so user rules cannot legitimately contain it)
 *
 * Returns true for rules like _sys_https_redirect, _sys_auth_krbdelegate,
 * etc.  Returns false for user rules that happen to start with _sys_ but
 * lack the marker, and for F5 rules whose name has been changed away from
 * the _sys_ prefix (both treated as operator-owned and therefore shown).
 */
function isSystemRule(name, content) {
  if (!name || name.indexOf('_sys_') !== 0) { return false; }
  if (!content) { return false; }
  // Strip leading whitespace, take up to 32 chars, lowercase for match.
  // F5's marker is "nodelete nowrite " as the literal first token.
  var head = content.replace(/^\s+/, '').slice(0, 32).toLowerCase();
  return head.indexOf('nodelete nowrite') === 0;
}

/**
 * Snapshot all iRules in the provided map. Only creates a new version entry
 * if no manifest exists yet for that rule (first-run baseline).
 *
 * @param {object}   rules    - map from tmsh.listAllRules
 * @param {string}   dataDir
 * @param {object}   [opts]   - { skipSystem: true } to skip _sys_* F5 rules
 * @param {function} cb       - cb(err, count)
 */
function baselineSnapshot(rules, dataDir, optsOrCb, maybeCb) {
  // Back-compat: if called as baselineSnapshot(rules, dataDir, cb), no opts.
  var opts, cb;
  if (typeof optsOrCb === 'function') {
    opts = {};
    cb = optsOrCb;
  } else {
    opts = optsOrCb || {};
    cb = maybeCb;
  }
  var skipSystem = !!opts.skipSystem;

  var ruleKeys = Object.keys(rules);
  var count = 0;
  var skipped = 0;
  var idx = 0;

  function next() {
    if (idx >= ruleKeys.length) {
      if (skipped > 0) {
        logger.info('baselineSnapshot: skipped ' + skipped + ' F5 system iRule(s)');
      }
      return cb(null, count);
    }
    var rule = rules[ruleKeys[idx]];
    idx++;

    if (skipSystem && isSystemRule(rule.name, rule.content)) {
      skipped++;
      return next();
    }

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
 * After saving, prunes orphaned blobs if retention removed any entries.
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
        var countBefore = manifest.versions.length;
        _applyRetention(manifest);
        var retentionTrimmed = manifest.versions.length < countBefore;

        _saveManifest(dataDir, partition, name, manifest, function (saveErr) {
          if (saveErr) { return cb(saveErr); }

          // Option C: prune orphaned blobs on every save that involved retention trimming
          if (retentionTrimmed) {
            var migrations = require('./migrations');
            migrations.pruneOrphanedBlobs(ruleDir, function (pruneErr, pruned) {
              if (pruneErr) { logger.warn('saveVersion: blob prune error: ' + pruneErr.message); }
              else if (pruned > 0) { logger.info('saveVersion: pruned ' + pruned + ' orphaned blob(s) in ' + ruleDir); }
              cb(null, entry);
            });
          } else {
            cb(null, entry);
          }
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
  _walkManifests(dataDir, function (walkErr, manifests) {
    if (walkErr) { return cb(walkErr); }

    var liveKeys = Object.keys(liveRules);

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
        onSystem: !!liveRule,
        acknowledged: m.acknowledged !== false
      });
    });

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
// Export / Import
// ---------------------------------------------------------------------------

/**
 * Export the full data directory as a tar.gz.
 * Shells out to /bin/tar — always available on BIG-IP.
 * Writes to destPath, then calls cb(err).
 *
 * @param {string}   dataDir   - source directory
 * @param {string}   destPath  - absolute path for the output .tar.gz file
 * @param {function} cb        - cb(err)
 */
function exportArchive(dataDir, destPath, cb) {
  var childProcess = require('child_process');
  // Use -C to make paths relative inside the archive, so importing
  // works regardless of destination path.
  // Archive root is named "data" for easy identification on extraction.
  var parentDir = path.dirname(dataDir);
  var baseName = path.basename(dataDir);
  logger.info('exportArchive: tar -czf ' + destPath + ' -C ' + parentDir + ' ' + baseName);
  childProcess.execFile('/bin/tar', ['-czf', destPath, '-C', parentDir, baseName], {
    timeout: 60000
  }, function (err, stdout, stderr) {
    if (err) {
      logger.error('exportArchive: tar failed: ' + (stderr || err.message));
      return cb(new Error('tar export failed: ' + (stderr || err.message)));
    }
    logger.info('exportArchive: success, wrote ' + destPath);
    cb(null);
  });
}

/**
 * Import a tar.gz archive into the data directory.
 * The archive must have been created by exportArchive (contains a "data/"
 * top-level directory).
 *
 * @param {string}   archivePath  - path to the .tar.gz on the local filesystem
 * @param {string}   dataDir      - destination data directory
 * @param {string}   conflictMode - 'merge' | 'replace'
 * @param {function} cb           - cb(err, report)
 *
 * report = { imported: N, merged: N, replaced: N, skipped: N, conflicts: [{partition, name}] }
 *
 * Strategy:
 *   - Extract archive to a temp directory
 *   - Walk extracted rule directories
 *   - For each rule, if no local manifest exists: copy blobs + manifest (always)
 *   - If local manifest exists:
 *       merge:   append imported versions not already present (by hash);
 *                copy missing blob files
 *       replace: overwrite manifest entirely; copy all blob files
 */
function importArchive(archivePath, dataDir, conflictMode, cb) {
  var childProcess = require('child_process');
  var tmpDir = '/tmp/.irv-import-' + Date.now();

  // Step 1: extract to temp directory
  _mkdirp(tmpDir, function (mkErr) {
    if (mkErr) { return cb(mkErr); }

    childProcess.execFile('/bin/tar', ['-xzf', archivePath, '-C', tmpDir], {
      timeout: 60000
    }, function (tarErr, stdout, stderr) {
      if (tarErr) {
        _rmrf(tmpDir, function () {});
        return cb(new Error('tar import failed: ' + (stderr || tarErr.message)));
      }

      // The archive contains a top-level "data/" directory
      var extractedDataDir = path.join(tmpDir, 'data');
      fs.stat(extractedDataDir, function (statErr) {
        if (statErr) {
          // Try the directory itself (in case the archive root IS the data dir)
          extractedDataDir = tmpDir;
        }
        _importFromDir(extractedDataDir, dataDir, conflictMode, function (importErr, report) {
          _rmrf(tmpDir, function () {});
          cb(importErr, report);
        });
      });
    });
  });
}

/**
 * Scan the extracted directory and determine which rules have conflicts
 * (i.e. already exist locally).  Returns the conflict list without
 * modifying any data — used by the GUI to present the conflict modal.
 *
 * @param {string}   archivePath
 * @param {string}   dataDir
 * @param {function} cb  - cb(err, conflicts)
 *   conflicts = [{ partition, name }]  — rules present in both archive and store
 */
/**
 * Analyse an archive against the local store and return a structured summary.
 *
 * Response shape:
 * {
 *   summary: {
 *     identical:     N,   // in both, all hashes match
 *     archiveHasNew: N,   // archive has versions local lacks  -> merge adds them
 *     localHasNew:   N,   // local has versions archive lacks  -> replace would lose them
 *     newToLocal:    N    // in archive only (not in local store at all)
 *   },
 *   rules: [
 *     { partition, name, status: "identical"|"archiveHasNew"|"localHasNew"|"both"|"newToLocal",
 *       archiveNewCount, localNewCount }
 *   ],
 *   hasConflicts: bool   // true only when localHasNew > 0 (replace would destroy data)
 * }
 */
function checkImportConflicts(archivePath, dataDir, cb) {
  var childProcess = require('child_process');
  var tmpDir = '/tmp/.irv-conflict-check-' + Date.now();

  _mkdirp(tmpDir, function (mkErr) {
    if (mkErr) { return cb(mkErr); }

    childProcess.execFile('/bin/tar', ['-xzf', archivePath, '-C', tmpDir], {
      timeout: 60000
    }, function (tarErr, stdout, stderr) {
      if (tarErr) {
        _rmrf(tmpDir, function () {});
        return cb(new Error('tar extract failed: ' + (stderr || tarErr.message)));
      }

      var extractedDataDir = path.join(tmpDir, 'data');
      fs.stat(extractedDataDir, function (statErr) {
        if (statErr) { extractedDataDir = tmpDir; }
        _analyseImport(extractedDataDir, dataDir, function (err, result) {
          _rmrf(tmpDir, function () {});
          cb(err, result);
        });
      });
    });
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
    acknowledged: false,
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
 * Apply the retention policy to a manifest in-memory.
 * Removes excess version entries.  Orphaned blob files are cleaned up
 * separately by migrations.pruneOrphanedBlobs() after the manifest is saved.
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

function _walkManifests(dataDir, cb) {
  var manifests = [];
  fs.readdir(dataDir, function (err, partitions) {
    if (err) { return cb(null, []); }
    var pendingPartitions = partitions.filter(function (p) {
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

/**
 * Copy a single file from src to dest, creating dest directory if needed.
 */
function _copyFile(src, dest, cb) {
  _mkdirp(path.dirname(dest), function (mkErr) {
    if (mkErr) { return cb(mkErr); }
    fs.readFile(src, function (readErr, data) {
      if (readErr) { return cb(readErr); }
      fs.writeFile(dest, data, cb);
    });
  });
}

/**
 * Recursively remove a directory tree.  Best-effort (ignores errors).
 */
function _rmrf(dirPath, cb) {
  fs.readdir(dirPath, function (err, entries) {
    if (err) { return cb(); }
    var idx = 0;
    function next() {
      if (idx >= entries.length) {
        fs.rmdir(dirPath, function () { cb(); });
        return;
      }
      var entry = path.join(dirPath, entries[idx++]);
      fs.stat(entry, function (statErr, stat) {
        if (statErr) { return next(); }
        if (stat.isDirectory()) {
          _rmrf(entry, next);
        } else {
          fs.unlink(entry, function () { next(); });
        }
      });
    }
    next();
  });
}

/**
 * Find rules present in both the extracted archive and the local store.
 */
/**
 * Walk the extracted archive directory and compare each rule against the local
 * store by hash set, producing a per-rule status and aggregate summary.
 *
 * Per-rule status values:
 *   "newToLocal"    - rule is in archive but has no local manifest at all
 *   "identical"     - both have the same set of hashes, nothing to do
 *   "archiveHasNew" - archive contains hashes local lacks (merge adds them)
 *   "localHasNew"   - local contains hashes archive lacks (replace would lose them)
 *   "both"          - each side has hashes the other lacks
 */
function _analyseImport(extractedDir, dataDir, cb) {
  var summary = { identical: 0, archiveHasNew: 0, localHasNew: 0, newToLocal: 0 };
  var rules = [];

  fs.readdir(extractedDir, function (err, entries) {
    if (err) { return cb(null, { summary: summary, rules: rules, hasConflicts: false }); }

    var partitions = entries.filter(function (e) {
      return e.slice(-5) !== '.json' && e.slice(-6) !== '.jsonl';
    });
    if (partitions.length === 0) {
      return cb(null, { summary: summary, rules: rules, hasConflicts: false });
    }

    var partsDone = 0;
    partitions.forEach(function (partition) {
      var srcPartDir = path.join(extractedDir, partition);
      fs.stat(srcPartDir, function (statErr, stat) {
        if (statErr || !stat.isDirectory()) {
          partsDone++;
          if (partsDone === partitions.length) { _finish(); }
          return;
        }
        fs.readdir(srcPartDir, function (rdErr, ruleDirs) {
          if (rdErr) {
            partsDone++;
            if (partsDone === partitions.length) { _finish(); }
            return;
          }
          if (ruleDirs.length === 0) {
            partsDone++;
            if (partsDone === partitions.length) { _finish(); }
            return;
          }

          var rulesDone = 0;
          ruleDirs.forEach(function (ruleDir) {
            var srcManifestPath = path.join(srcPartDir, ruleDir, 'manifest.json');
            var localManifestPath = path.join(dataDir, partition, ruleDir, 'manifest.json');

            // Read archive manifest
            fs.readFile(srcManifestPath, { encoding: 'utf8' }, function (srcErr, srcData) {
              if (srcErr) {
                // No valid manifest in archive for this dir — skip
                rulesDone++;
                if (rulesDone === ruleDirs.length) {
                  partsDone++;
                  if (partsDone === partitions.length) { _finish(); }
                }
                return;
              }

              var srcManifest;
              try { srcManifest = JSON.parse(srcData); } catch (e) {
                rulesDone++;
                if (rulesDone === ruleDirs.length) {
                  partsDone++;
                  if (partsDone === partitions.length) { _finish(); }
                }
                return;
              }

              var archiveHashes = {};
              (srcManifest.versions || []).forEach(function (v) {
                archiveHashes[v.hash] = true;
              });

              // Read local manifest
              fs.readFile(localManifestPath, { encoding: 'utf8' }, function (localErr, localData) {
                var ruleInfo = { partition: partition, name: ruleDir,
                                 status: 'newToLocal', archiveNewCount: 0, localNewCount: 0 };

                if (localErr) {
                  // Rule not in local store at all
                  ruleInfo.status = 'newToLocal';
                  ruleInfo.archiveNewCount = (srcManifest.versions || []).length;
                  summary.newToLocal++;
                } else {
                  var localManifest;
                  try { localManifest = JSON.parse(localData); } catch (e) { localManifest = { versions: [] }; }

                  var localHashes = {};
                  (localManifest.versions || []).forEach(function (v) {
                    localHashes[v.hash] = true;
                  });

                  // Hashes in archive not in local
                  var archiveNew = Object.keys(archiveHashes).filter(function (h) {
                    return !localHashes[h];
                  }).length;
                  // Hashes in local not in archive
                  var localNew = Object.keys(localHashes).filter(function (h) {
                    return !archiveHashes[h];
                  }).length;

                  ruleInfo.archiveNewCount = archiveNew;
                  ruleInfo.localNewCount   = localNew;

                  if (archiveNew === 0 && localNew === 0) {
                    ruleInfo.status = 'identical';
                    summary.identical++;
                  } else if (archiveNew > 0 && localNew === 0) {
                    ruleInfo.status = 'archiveHasNew';
                    summary.archiveHasNew++;
                  } else if (archiveNew === 0 && localNew > 0) {
                    ruleInfo.status = 'localHasNew';
                    summary.localHasNew++;
                  } else {
                    ruleInfo.status = 'both';
                    // Count as both for summary purposes
                    summary.archiveHasNew++;
                    summary.localHasNew++;
                  }
                }

                rules.push(ruleInfo);
                rulesDone++;
                if (rulesDone === ruleDirs.length) {
                  partsDone++;
                  if (partsDone === partitions.length) { _finish(); }
                }
              });
            });
          });
        });
      });
    });

    function _finish() {
      var hasConflicts = summary.localHasNew > 0;
      cb(null, { summary: summary, rules: rules, hasConflicts: hasConflicts });
    }
  });
}

/**
 * Perform the actual import from an extracted directory into dataDir.
 */
function _importFromDir(extractedDir, dataDir, conflictMode, cb) {
  var report = { imported: 0, merged: 0, replaced: 0, skipped: 0, conflicts: [] };

  fs.readdir(extractedDir, function (err, entries) {
    if (err) { return cb(null, report); }
    var partitions = entries.filter(function (e) {
      return e.slice(-5) !== '.json' && e.slice(-6) !== '.jsonl';
    });
    if (partitions.length === 0) { return cb(null, report); }

    var partsDone = 0;
    partitions.forEach(function (partition) {
      var srcPartDir = path.join(extractedDir, partition);
      fs.stat(srcPartDir, function (statErr, stat) {
        if (statErr || !stat.isDirectory()) {
          partsDone++;
          if (partsDone === partitions.length) { cb(null, report); }
          return;
        }
        fs.readdir(srcPartDir, function (rdErr, ruleDirs) {
          if (rdErr) {
            partsDone++;
            if (partsDone === partitions.length) { cb(null, report); }
            return;
          }
          if (ruleDirs.length === 0) {
            partsDone++;
            if (partsDone === partitions.length) { cb(null, report); }
            return;
          }

          var rulesDone = 0;
          ruleDirs.forEach(function (ruleDir) {
            var srcRuleDir = path.join(srcPartDir, ruleDir);
            var destRuleDir = path.join(dataDir, partition, ruleDir);
            var srcManifestPath = path.join(srcRuleDir, 'manifest.json');

            fs.readFile(srcManifestPath, { encoding: 'utf8' }, function (mErr, mData) {
              if (mErr) {
                // No manifest in extracted dir — skip
                rulesDone++;
                if (rulesDone === ruleDirs.length) {
                  partsDone++;
                  if (partsDone === partitions.length) { cb(null, report); }
                }
                return;
              }

              var srcManifest;
              try { srcManifest = JSON.parse(mData); } catch (e) {
                rulesDone++;
                if (rulesDone === ruleDirs.length) {
                  partsDone++;
                  if (partsDone === partitions.length) { cb(null, report); }
                }
                return;
              }

              var destManifestPath = path.join(destRuleDir, 'manifest.json');
              fs.access(destManifestPath, fs.F_OK, function (accessErr) {
                var hasLocalManifest = !accessErr;

                if (!hasLocalManifest) {
                  // No conflict — copy everything
                  _copyRuleDir(srcRuleDir, destRuleDir, srcManifest, function (copyErr) {
                    if (!copyErr) { report.imported++; }
                    rulesDone++;
                    if (rulesDone === ruleDirs.length) {
                      partsDone++;
                      if (partsDone === partitions.length) { cb(null, report); }
                    }
                  });
                } else {
                  // Conflict
                  report.conflicts.push({ partition: partition, name: ruleDir });

                  if (conflictMode === 'replace') {
                    _copyRuleDir(srcRuleDir, destRuleDir, srcManifest, function (copyErr) {
                      if (!copyErr) { report.replaced++; }
                      rulesDone++;
                      if (rulesDone === ruleDirs.length) {
                        partsDone++;
                        if (partsDone === partitions.length) { cb(null, report); }
                      }
                    });
                  } else {
                    // merge (default)
                    _mergeRuleDir(srcRuleDir, destRuleDir, srcManifest, function (mergeErr) {
                      if (!mergeErr) { report.merged++; }
                      rulesDone++;
                      if (rulesDone === ruleDirs.length) {
                        partsDone++;
                        if (partsDone === partitions.length) { cb(null, report); }
                      }
                    });
                  }
                }
              });
            });
          });
        });
      });
    });
  });
}

/**
 * Copy all blobs + manifest from src to dest rule directory.
 */
function _copyRuleDir(srcDir, destDir, srcManifest, cb) {
  _mkdirp(destDir, function (mkErr) {
    if (mkErr) { return cb(mkErr); }
    var blobs = (srcManifest.versions || []).map(function (v) { return v.blobFile; }).filter(Boolean);
    // Also write the manifest
    var destManifestPath = path.join(destDir, 'manifest.json');
    fs.writeFile(destManifestPath, JSON.stringify(srcManifest, null, 2), { encoding: 'utf8' }, function (wErr) {
      if (wErr) { return cb(wErr); }
      if (blobs.length === 0) { return cb(null); }
      var idx = 0;
      function next() {
        if (idx >= blobs.length) { return cb(null); }
        var blobName = blobs[idx++];
        var src = path.join(srcDir, blobName);
        var dest = path.join(destDir, blobName);
        fs.readFile(src, function (rErr, data) {
          if (rErr) { return next(); } // skip missing blobs gracefully
          fs.writeFile(dest, data, function () { next(); });
        });
      }
      next();
    });
  });
}

/**
 * Merge imported versions into an existing rule directory.
 * Appends versions from srcManifest whose hash is not already present
 * in the local manifest.  Copies the corresponding blob files.
 */
function _mergeRuleDir(srcDir, destDir, srcManifest, cb) {
  var destManifestPath = path.join(destDir, 'manifest.json');
  fs.readFile(destManifestPath, { encoding: 'utf8' }, function (rErr, data) {
    if (rErr) {
      // No local manifest — treat as a straight copy
      return _copyRuleDir(srcDir, destDir, srcManifest, cb);
    }
    var localManifest;
    try { localManifest = JSON.parse(data); } catch (e) {
      return _copyRuleDir(srcDir, destDir, srcManifest, cb);
    }

    // Build set of existing hashes
    var existingHashes = {};
    (localManifest.versions || []).forEach(function (v) { existingHashes[v.hash] = true; });

    var newVersions = (srcManifest.versions || []).filter(function (v) {
      return !existingHashes[v.hash];
    });

    if (newVersions.length === 0) { return cb(null); } // nothing to add

    // Copy blob files for new versions, then update manifest
    var idx = 0;
    function next() {
      if (idx >= newVersions.length) {
        // Append new versions (by timestamp order) and save manifest
        localManifest.versions = localManifest.versions.concat(newVersions);
        localManifest.versions.sort(function (a, b) {
          return a.timestamp < b.timestamp ? -1 : 1;
        });
        fs.writeFile(destManifestPath, JSON.stringify(localManifest, null, 2),
          { encoding: 'utf8' }, cb);
        return;
      }
      var v = newVersions[idx++];
      var srcBlob = path.join(srcDir, v.blobFile);
      var destBlob = path.join(destDir, v.blobFile);
      fs.readFile(srcBlob, function (readErr, blobData) {
        if (readErr) { return next(); } // skip missing blobs
        fs.writeFile(destBlob, blobData, function () { next(); });
      });
    }
    next();
  });
}

/**
 * Mark a rule as acknowledged — clears the "new" state.
 * Safe to call on already-acknowledged rules (idempotent).
 */
function acknowledgeRule(dataDir, partition, name, cb) {
  _loadManifest(dataDir, partition, name, function (err, manifest) {
    if (err) { return cb(err); }
    if (manifest.acknowledged === true) { return cb(null); } // already done
    manifest.acknowledged = true;
    _saveManifest(dataDir, partition, name, manifest, cb);
  });
}

/**
 * Acknowledge every rule in the store that has at least one version and is
 * not currently drifted.  Drifted rules are skipped — those need per-rule
 * review.  Rules with zero versions are skipped (no baseline yet).
 *
 * @param {string}   dataDir
 * @param {object}   liveRules  - map from bigipClient.listAllRules, used
 *                                to compute drift vs the stored latestHash
 * @param {function} cb         - cb(err, { acknowledged, skipped,
 *                                skippedDrift, skippedNoVersions,
 *                                alreadyAcknowledged })
 */
function acknowledgeAll(dataDir, liveRules, cb) {
  _walkManifests(dataDir, function (walkErr, manifests) {
    if (walkErr) { return cb(walkErr); }

    var acknowledged = 0;
    var alreadyAcknowledged = 0;
    var skippedDrift = 0;
    var skippedNoVersions = 0;
    var i = 0;

    function next() {
      if (i >= manifests.length) {
        return cb(null, {
          acknowledged: acknowledged,
          alreadyAcknowledged: alreadyAcknowledged,
          skipped: skippedDrift + skippedNoVersions,
          skippedDrift: skippedDrift,
          skippedNoVersions: skippedNoVersions
        });
      }
      var m = manifests[i];
      i++;

      if (!m.versions || m.versions.length === 0) {
        skippedNoVersions++;
        return next();
      }
      if (m.acknowledged === true) {
        alreadyAcknowledged++;
        return next();
      }

      // Drift check: compare live content hash to stored latest hash.
      var key = '/' + m.partition + '/' + m.name;
      var live = liveRules && liveRules[key];
      var latest = m.versions[m.versions.length - 1];
      if (live && latest) {
        var liveHash = _shortHash(live.content);
        if (liveHash !== latest.hash) {
          skippedDrift++;
          return next();
        }
      }

      m.acknowledged = true;
      _saveManifest(dataDir, m.partition, m.name, m, function (saveErr) {
        if (saveErr) {
          logger.warn('acknowledgeAll: save failed for ' + key + ': ' + saveErr.message);
        } else {
          acknowledged++;
        }
        next();
      });
    }

    next();
  });
}

module.exports = {
  init: init,
  baselineSnapshot: baselineSnapshot,
  saveVersion: saveVersion,
  listRules: listRules,
  getManifest: getManifest,
  getVersionContent: getVersionContent,
  appendAudit: appendAudit,
  exportArchive: exportArchive,
  importArchive: importArchive,
  checkImportConflicts: checkImportConflicts,
  acknowledgeRule: acknowledgeRule,
  acknowledgeAll: acknowledgeAll,
  isSystemRule: isSystemRule
};
