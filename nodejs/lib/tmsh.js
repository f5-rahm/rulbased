'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var logger = require('./logger');

var TMSH = '/usr/bin/tmsh';
var TEMP_DIR = '/var/tmp';

/**
 * tmsh.js — WRITE OPERATIONS ONLY
 *
 * Handles all BIG-IP config mutations via tmsh child_process calls.
 * Read operations (listing rules, fetching content) are in bigipClient.js
 * which uses the localhost:8100 iControl REST trusted channel.
 *
 * Why tmsh for writes:
 *   - "tmsh load sys config merge file" is the battle-tested path for
 *     pushing iRule content — used by AS3 and other F5 tooling
 *   - "tmsh save sys config" provides an explicit persistence guarantee
 *   - Avoids the async task/polling complexity of the iControl REST
 *     config transaction API for write operations
 *   - Rule content is written to a temp file rather than inlined in the
 *     command to avoid TCL quoting issues with multi-line content
 */

/**
 * Run a tmsh command and return stdout.
 * @param {string[]} args - tmsh arguments
 * @param {function} cb   - cb(err, stdout)
 */
function run(args, cb) {
  // Set HOME to /var/tmp so tmsh can write its history file (.tmsh-history-root).
  // Without this, tmsh running as the restnoded user (uid 198, home=//) fails
  // with exit code 1 after a successful load because it can't open its history
  // file at //.tmsh-history-root — causing a false deploy failure.
  var env = {};
  var key;
  for (key in process.env) {
    if (process.env.hasOwnProperty(key)) { env[key] = process.env[key]; }
  }
  env.HOME = '/var/tmp';

  childProcess.execFile(TMSH, args, {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
    env: env
  }, function (err, stdout, stderr) {
    if (err) {
      logger.severe('tmsh ' + args.join(' ') + ' failed: ' + (stderr || err.message));
      return cb(new Error(stderr || err.message));
    }
    cb(null, stdout);
  });
}

/**
 * Deploy an iRule by writing content to a temp file and merging.
 * Creates the rule if it does not exist; updates if it does.
 * Always calls "tmsh save sys config" after a successful load.
 *
 * @param {string}   partition
 * @param {string}   name
 * @param {string}   content  - raw TCL body (no outer "ltm rule /P/N { }" wrapper)
 * @param {function} cb       - cb(err)
 */
function deployRule(partition, name, content, cb) {
  var fullPath = '/' + partition + '/' + name;
  var tempFile = path.join(TEMP_DIR, 'irule_stage_' + Date.now() + '.tcl');
  var stanza = 'ltm rule ' + fullPath + ' {\n' + content + '\n}\n';

  logger.info('tmsh.deployRule: writing staging file ' + tempFile + ' (' + stanza.length + ' bytes)');

  fs.writeFile(tempFile, stanza, { encoding: 'utf8', mode: 384 }, function (writeErr) { // 384 = 0600 octal
    if (writeErr) {
      logger.severe('tmsh.deployRule: writeFile failed: ' + writeErr.message);
      return cb(new Error('Failed to write staging file: ' + writeErr.message));
    }

    // Verify the file is readable before handing to tmsh
    fs.stat(tempFile, function (statErr, stat) {
      if (statErr) {
        logger.severe('tmsh.deployRule: stat failed after write: ' + statErr.message);
        return cb(new Error('Staging file not accessible after write: ' + statErr.message));
      }
      logger.info('tmsh.deployRule: staging file ok, size=' + stat.size + ' mode=' + stat.mode.toString(8));

      run(['-c', 'load sys config merge file ' + tempFile], function (loadErr) {
        fs.unlink(tempFile, function () {});

        if (loadErr) {
          logger.severe('tmsh.deployRule: load failed: ' + loadErr.message);
          return cb(loadErr);
        }

        logger.info('tmsh.deployRule: load succeeded, saving config');
        run(['-c', 'save sys config'], function (saveErr) {
          if (saveErr) {
            logger.warning('deployRule: save sys config failed (non-fatal): ' + saveErr.message);
          }
          cb(null);
        });
      });
    });
  });
}

module.exports = {
  deployRule: deployRule
};
