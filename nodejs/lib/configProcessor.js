'use strict';

var blockUtil = require('./blockUtil');
var versionStore = require('./versionStore');
var tmsh = require('./tmsh');
var bigipClient = require('./bigipClient');
var logger = require('./logger');

var WORKER_URI_PATH = 'shared/iapp/processors/rulbased';
var VERSION = '2.1.0';

/**
 * iApps LX Config Processor
 *
 * Handles the block state machine:
 *   TEMPLATE  -> block template is available, no instance yet
 *   BINDING   -> instance being created, we provision here
 *   BOUND     -> instance active and running
 *   UNBINDING -> instance being deleted, we clean up here
 *   ERROR     -> something went wrong
 */
function ConfigProcessor() {
  this.WORKER_URI_PATH = WORKER_URI_PATH;
  this.isPublic = true;
  this.isPassThrough = false;
}

/**
 * Called by the iApps LX framework when a block transitions to BINDING.
 * We initialise the data directory, take baseline snapshots of all iRules,
 * and write initial output properties back to the block.
 */
ConfigProcessor.prototype.onPost = function (restOperation) {
  var body = restOperation.getBody();
  var inputProperties = blockUtil.getInputProperties(body);

  var dataDir = inputProperties.dataDirectory ||
    '/var/config/rest/iapps/rulbased/data';
  var pollInterval = inputProperties.pollIntervalSeconds !== undefined
    ? inputProperties.pollIntervalSeconds : 300;

  logger.info('ConfigProcessor.onPost: BINDING block, dataDir=' + dataDir);

  // Initialise the version store on disk
  versionStore.init(dataDir, function (initErr) {
    if (initErr) {
      logger.error('ConfigProcessor.onPost: versionStore.init failed: ' + initErr.message);
      blockUtil.setError(restOperation, 'Failed to initialise data directory: ' + initErr.message);
      return;
    }

    // Take baseline snapshots of every iRule currently on the system
    bigipClient.listAllRules(function (listErr, rules) {
      if (listErr) {
        logger.error('ConfigProcessor.onPost: tmsh.listAllRules failed: ' + listErr.message);
        blockUtil.setError(restOperation, 'Failed to list iRules: ' + listErr.message);
        return;
      }

      var ruleNames = Object.keys(rules);
      logger.info('ConfigProcessor.onPost: found ' + ruleNames.length + ' iRules, snapshotting...');

      versionStore.baselineSnapshot(rules, dataDir, function (snapErr, count) {
        if (snapErr) {
          logger.error('ConfigProcessor.onPost: baseline snapshot failed: ' + snapErr.message);
          blockUtil.setError(restOperation, 'Baseline snapshot failed: ' + snapErr.message);
          return;
        }

        logger.info('ConfigProcessor.onPost: baseline complete, ' + count + ' rules snapshotted');

        // Start the poll worker if polling is enabled
        if (pollInterval > 0) {
          var pollWorker = require('./pollWorker');
          pollWorker.start(dataDir, pollInterval);
        }

        // Write output properties and transition to BOUND
        var outputProperties = [
          { id: 'trackedRuleCount', value: count },
          { id: 'driftedRuleCount', value: 0 },
          { id: 'lastPollTimestamp', value: new Date().toISOString() },
          { id: 'installedVersion', value: VERSION }
        ];

        blockUtil.setBound(restOperation, outputProperties);
      });
    });
  });
};

/**
 * Called when the block is already BOUND and settings are updated.
 * Re-reads input properties and restarts the poll worker if the interval changed.
 */
ConfigProcessor.prototype.onPut = function (restOperation) {
  var body = restOperation.getBody();
  var inputProperties = blockUtil.getInputProperties(body);
  var pollInterval = inputProperties.pollIntervalSeconds !== undefined
    ? inputProperties.pollIntervalSeconds : 300;
  var dataDir = inputProperties.dataDirectory ||
    '/var/config/rest/iapps/rulbased/data';

  logger.info('ConfigProcessor.onPut: updating settings, pollInterval=' + pollInterval);

  var pollWorker = require('./pollWorker');
  pollWorker.stop();
  if (pollInterval > 0) {
    pollWorker.start(dataDir, pollInterval);
  }

  blockUtil.setBound(restOperation, []);
};

/**
 * Called when the block transitions to UNBINDING.
 * Stop the poll worker; leave the version store data on disk
 * so it survives a re-install or upgrade.
 */
ConfigProcessor.prototype.onDelete = function (restOperation) {
  logger.info('ConfigProcessor.onDelete: UNBINDING, stopping poll worker');
  var pollWorker = require('./pollWorker');
  pollWorker.stop();
  blockUtil.setUnbound(restOperation);
};

module.exports = ConfigProcessor;
