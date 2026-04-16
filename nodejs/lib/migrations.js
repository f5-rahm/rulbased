'use strict';

var fs = require('fs');
var path = require('path');
var logger = require('./logger');

/**
 * migrations.js
 *
 * Schema migration framework for the Rülbased version store.
 *
 * schemaVersion is stored as an integer in settings.json under the key
 * "schemaVersion".  A missing key (pre-Phase-6 installs) is treated as
 * version 0.  Migrations are run in ascending order on every startup;
 * already-applied migrations are skipped.
 *
 * Adding a new migration:
 *   1. Write a function  migration_N(dataDir, cb)  that calls cb(err) when done.
 *   2. Push it onto the MIGRATIONS array below with its target version number.
 *   3. Bump CURRENT_SCHEMA_VERSION.
 *
 * Migrations must be idempotent — they may be re-run if a previous attempt
 * was interrupted.
 */

var CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

/**
 * v0 → v1 : Orphaned blob sweep
 *
 * Prior to Phase 6, _applyRetention removed version entries from manifests
 * but never deleted the corresponding .tcl blob files on disk.  This
 * migration walks every rule directory and unlinks blobs that are no longer
 * referenced by any version entry in the manifest.
 */
function migration_1(dataDir, cb) {
  logger.info('migrations: running v0→v1: orphaned blob sweep');
  _walkRuleDirs(dataDir, function (err, ruleDirs) {
    if (err) { return cb(err); }
    if (ruleDirs.length === 0) { return cb(null); }
    var idx = 0;
    var totalPruned = 0;
    function next() {
      if (idx >= ruleDirs.length) {
        logger.info('migrations: v0→v1 complete, pruned ' + totalPruned + ' orphaned blob(s)');
        return cb(null);
      }
      var ruleDir = ruleDirs[idx++];
      _pruneOrphanedBlobs(ruleDir, function (pruneErr, count) {
        if (pruneErr) {
          logger.warn('migrations: blob sweep error in ' + ruleDir + ': ' + pruneErr.message);
        } else {
          totalPruned += count;
        }
        next();
      });
    }
    next();
  });
}

var MIGRATIONS = [
  { version: 1, fn: migration_1 }
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all outstanding migrations.
 * Reads schemaVersion from settings.json, runs any migrations whose target
 * version is > storedVersion, then writes the new schemaVersion back.
 *
 * @param {string}   dataDir  - path to the data directory
 * @param {object}   settingsMod - the settings module (passed in to avoid
 *                   circular require; also allows settings to be updated
 *                   after migrations complete)
 * @param {function} cb       - cb(err)
 */
function run(dataDir, settingsMod, cb) {
  var storedVersion = _readSchemaVersion(settingsMod);
  if (storedVersion >= CURRENT_SCHEMA_VERSION) {
    logger.debug('migrations: schema up to date (v' + storedVersion + ')');
    return cb(null);
  }

  logger.info('migrations: stored v' + storedVersion + ', current v' + CURRENT_SCHEMA_VERSION + ' — running migrations');

  var pending = MIGRATIONS.filter(function (m) { return m.version > storedVersion; });
  var idx = 0;

  function next() {
    if (idx >= pending.length) {
      // All migrations complete — write new schema version
      try {
        settingsMod.update({ schemaVersion: CURRENT_SCHEMA_VERSION });
        logger.info('migrations: schema version updated to v' + CURRENT_SCHEMA_VERSION);
      } catch (e) {
        logger.warn('migrations: could not persist schemaVersion: ' + e.message);
      }
      return cb(null);
    }
    var migration = pending[idx++];
    logger.info('migrations: running migration to v' + migration.version);
    migration.fn(dataDir, function (err) {
      if (err) {
        logger.error('migrations: migration to v' + migration.version + ' failed: ' + err.message);
        return cb(err);
      }
      next();
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// Orphaned blob pruner — also exported for use by versionStore on every save
// ---------------------------------------------------------------------------

/**
 * Prune orphaned .tcl blob files from a rule directory.
 * A blob is orphaned if it is not referenced by any version entry in the
 * manifest.  Safe to call after any manifest save.
 *
 * @param {string}   ruleDir  - absolute path to the rule's directory
 * @param {function} cb       - cb(err, prunedCount)
 */
function pruneOrphanedBlobs(ruleDir, cb) {
  _pruneOrphanedBlobs(ruleDir, cb);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _readSchemaVersion(settingsMod) {
  try {
    var all = settingsMod.getAll();
    var v = parseInt(all.schemaVersion, 10);
    return isNaN(v) ? 0 : v;
  } catch (e) {
    return 0;
  }
}

function _pruneOrphanedBlobs(ruleDir, cb) {
  var manifestPath = path.join(ruleDir, 'manifest.json');
  fs.readFile(manifestPath, { encoding: 'utf8' }, function (err, data) {
    if (err) { return cb(null, 0); } // no manifest — nothing to prune
    var manifest;
    try { manifest = JSON.parse(data); } catch (e) { return cb(null, 0); }

    // Build set of referenced blob filenames
    var referenced = {};
    (manifest.versions || []).forEach(function (v) {
      if (v.blobFile) { referenced[v.blobFile] = true; }
    });

    fs.readdir(ruleDir, function (rdErr, files) {
      if (rdErr) { return cb(rdErr, 0); }
      var blobs = files.filter(function (f) { return f.slice(-4) === '.tcl'; });
      var orphans = blobs.filter(function (f) { return !referenced[f]; });
      if (orphans.length === 0) { return cb(null, 0); }

      var pruned = 0;
      var idx = 0;
      function next() {
        if (idx >= orphans.length) { return cb(null, pruned); }
        var filePath = path.join(ruleDir, orphans[idx++]);
        fs.unlink(filePath, function (unlinkErr) {
          if (unlinkErr) {
            logger.warn('migrations: could not unlink orphan ' + filePath + ': ' + unlinkErr.message);
          } else {
            pruned++;
            logger.debug('migrations: pruned orphan ' + filePath);
          }
          next();
        });
      }
      next();
    });
  });
}

/**
 * Walk the data directory and return an array of all rule directory paths.
 */
function _walkRuleDirs(dataDir, cb) {
  var result = [];
  fs.readdir(dataDir, function (err, entries) {
    if (err) { return cb(null, []); }
    var partitions = entries.filter(function (e) {
      return e.slice(-5) !== '.json' && e.slice(-6) !== '.jsonl';
    });
    if (partitions.length === 0) { return cb(null, []); }

    var done = 0;
    partitions.forEach(function (partition) {
      var partDir = path.join(dataDir, partition);
      fs.stat(partDir, function (statErr, stat) {
        if (statErr || !stat.isDirectory()) {
          done++;
          if (done === partitions.length) { cb(null, result); }
          return;
        }
        fs.readdir(partDir, function (rdErr, ruleDirs) {
          if (!rdErr) {
            ruleDirs.forEach(function (ruleDir) {
              result.push(path.join(partDir, ruleDir));
            });
          }
          done++;
          if (done === partitions.length) { cb(null, result); }
        });
      });
    });
  });
}

module.exports = {
  run: run,
  pruneOrphanedBlobs: pruneOrphanedBlobs,
  CURRENT_SCHEMA_VERSION: CURRENT_SCHEMA_VERSION
};
