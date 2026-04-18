'use strict';

var bigipClient = require('./bigipClient');
var tmsh = require('./tmsh');  // retained for future write operations in poll
var versionStore = require('./versionStore');
var notifier = require('./notifier');
var settings = require('./settings');
var logger = require('./logger');

/**
 * pollWorker.js
 *
 * Runs a scheduled job that compares the current live iRule content
 * against the most recently stored version. If a difference is detected
 * (i.e. someone edited an iRule outside this tool), a new version entry
 * is automatically created with source='external-poll'.
 *
 * Uses a single-flight lock: if a poll cycle is still running when the
 * next interval fires, the new tick is skipped rather than stacking up.
 * This prevents tmsh call pile-up during failover or system load.
 */

var _timer = null;
var _running = false;
var _dataDir = null;

function start(dataDir, intervalSeconds) {
  _dataDir = dataDir;
  var ms = intervalSeconds * 1000;
  logger.info('pollWorker: starting, interval=' + intervalSeconds + 's');
  _timer = setInterval(function () {
    _poll();
  }, ms);
  // Also run once immediately on start so the UI shows fresh data
  _poll();
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('pollWorker: stopped');
  }
}

function _poll() {
  if (_running) {
    logger.debug('pollWorker: previous cycle still running, skipping tick');
    return;
  }
  _running = true;

  bigipClient.listAllRules(function (err, liveRules) {
    if (err) {
      logger.warn('pollWorker: tmsh.listAllRules failed: ' + err.message);
      _running = false;
      return;
    }

    var ruleKeys = Object.keys(liveRules);
    var idx = 0;
    var driftCount = 0;

    function next() {
      if (idx >= ruleKeys.length) {
        if (driftCount > 0) {
          logger.info('pollWorker: poll complete, ' + driftCount + ' external change(s) detected');
        }
        _running = false;
        return;
      }

      var rule = liveRules[ruleKeys[idx]];
      idx++;

      // Skip F5 system rules when the setting is on, so we don't accumulate
      // _sys_*.json manifests on disk.  Per PLANNING.md §Phase 8 Feature 2.
      var hideSys = settings.getAll().hideSystemRules !== false;
      if (hideSys && versionStore.isSystemRule(rule.name, rule.content)) {
        return next();
      }

      versionStore.getManifest(_dataDir, rule.partition, rule.name, function (manifestErr, manifest) {
        if (manifestErr) {
          // Rule not yet in store — create a baseline for it
          versionStore.saveVersion(
            _dataDir, rule.partition, rule.name, rule.content,
            'Auto-baseline (new rule detected by poll)', 'system', 'baseline',
            function () { next(); }
          );
          return;
        }

        var latest = manifest.versions.length
          ? manifest.versions[manifest.versions.length - 1]
          : null;

        if (!latest) {
          versionStore.saveVersion(
            _dataDir, rule.partition, rule.name, rule.content,
            'Auto-baseline (empty manifest)', 'system', 'baseline',
            function () { next(); }
          );
          return;
        }

        // Compare live content hash to stored latest hash
        var crypto = require('crypto');
        var liveHash = crypto.createHash('sha1').update(rule.content || '').digest('hex').slice(0, 7);

        if (liveHash !== latest.hash) {
          driftCount++;
          logger.info('pollWorker: external change detected on ' + rule.fullPath +
            ' (was ' + latest.hash + ', now ' + liveHash + ')');

          versionStore.saveVersion(
            _dataDir, rule.partition, rule.name, rule.content,
            'External change detected by poll', 'external', 'external-poll',
            function (saveErr) {
              if (saveErr) {
                logger.warn('pollWorker: failed to save external change for ' + rule.fullPath + ': ' + saveErr.message);
              }
              // Append to audit log
              versionStore.appendAudit(_dataDir, {
                ts: new Date().toISOString(),
                author: 'external',
                action: 'external-change-detected',
                rule: rule.fullPath,
                fromHash: latest.hash,
                toHash: liveHash,
                reason: 'Detected by scheduled poll'
              }, function () {
                notifier.emit({
                  action:    'external-change-detected',
                  rule:      rule.fullPath,
                  fromHash:  latest.hash,
                  toHash:    liveHash,
                  author:    'external',
                  reason:    'Detected by scheduled poll',
                  timestamp: new Date().toISOString(),
                  isDrift:   true
                }, _dataDir, versionStore.appendAudit);
                next();
              });
            }
          );
        } else {
          next();
        }
      });
    }

    next();
  });
}

module.exports = { start: start, stop: stop };
