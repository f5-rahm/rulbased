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
  childProcess.execFile(TMSH, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, function (err, stdout, stderr) {
    if (err) {
      logger.error('tmsh ' + args.join(' ') + ' failed: ' + (stderr || err.message));
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

  fs.writeFile(tempFile, stanza, { encoding: 'utf8', mode: 0o600 }, function (writeErr) {
    if (writeErr) {
      return cb(new Error('Failed to write staging file: ' + writeErr.message));
    }

    run(['-c', 'load sys config merge file ' + tempFile], function (loadErr) {
      fs.unlink(tempFile, function () {}); // always clean up temp file

      if (loadErr) { return cb(loadErr); }

      run(['-c', 'save sys config'], function (saveErr) {
        if (saveErr) {
          // Non-fatal — rule is deployed in memory. Log and continue.
          logger.warn('deployRule: save sys config failed: ' + saveErr.message);
        }
        cb(null);
      });
    });
  });
}

module.exports = {
  deployRule: deployRule
};
