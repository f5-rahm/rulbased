'use strict';

var http = require('http');
var logger = require('./logger');

/**
 * bigipClient.js
 *
 * iControl REST reads via localhost:8100.
 *
 * Authentication: when the X-Forwarded-Host header contains localhost or
 * 127.0.0.1, restjavad extracts the username from the Basic auth header
 * without validating the password. We send Authorization: Basic admin:
 * (username "admin", empty password) — the username is used for identity
 * but the password is never checked. No credentials are stored anywhere.
 *
 * This is the same mechanism used internally by F5's own tooling when
 * making on-box REST calls from the management plane.
 *
 * READ ONLY — all write operations remain in tmsh.js.
 */

var MGMT_HOST = 'localhost';
var MGMT_PORT = 8100;

// Basic auth with empty password — password is not validated on localhost
var AUTH_HEADER = 'Basic ' + Buffer.from('admin:').toString('base64');

/**
 * Make a GET request to the local iControl REST API.
 * @param {string}   path  - URI path e.g. '/mgmt/tm/ltm/rule'
 * @param {function} cb    - cb(err, parsedBody)
 */
function get(path, cb) {
  var options = {
    host: MGMT_HOST,
    port: MGMT_PORT,
    path: path,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': AUTH_HEADER
    }
  };

  logger.debug('bigipClient.get: ' + path);

  var req = http.request(options, function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (chunk) { body += chunk; });
    res.on('end', function () {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return cb(new Error('HTTP ' + res.statusCode + ' from ' + path + ': ' + body));
      }
      try {
        cb(null, JSON.parse(body));
      } catch (e) {
        cb(new Error('Failed to parse response from ' + path + ': ' + e.message));
      }
    });
  });

  req.on('error', function (err) {
    logger.error('bigipClient.get error on ' + path + ': ' + err.message);
    cb(err);
  });

  req.setTimeout(30000, function () {
    req.abort();
    cb(new Error('Timeout on GET ' + path));
  });

  req.end();
}

/**
 * List all iRules on the system across all partitions.
 * Returns an object keyed by fullPath ("/Common/my_rule") with value:
 *   { partition, name, fullPath, content }
 */
function listAllRules(cb) {
  var path = '/mgmt/tm/ltm/rule?$select=fullPath,apiAnonymous,partition';

  module.exports._get(path, function (err, body) {
    if (err) { return cb(err); }

    var rules = {};
    var items = (body && body.items) ? body.items : [];

    items.forEach(function (item) {
      var fullPath = item.fullPath ||
        ('/' + (item.partition || 'Common') + '/' + item.name);
      var partition = item.partition || 'Common';
      var name = fullPath.replace(/^\/[^\/]+\//, '');

      rules[fullPath] = {
        partition: partition,
        name: name,
        fullPath: fullPath,
        content: item.apiAnonymous || ''
      };
    });

    logger.info('bigipClient.listAllRules: found ' + Object.keys(rules).length + ' rules');
    cb(null, rules);
  });
}

/**
 * Get the TCL content of a single iRule by partition and name.
 */
function getRuleContent(partition, name, cb) {
  var encodedPath = '~' + partition + '~' + name;
  var path = '/mgmt/tm/ltm/rule/' + encodedPath + '?$select=apiAnonymous';

  module.exports._get(path, function (err, body) {
    if (err) { return cb(err); }
    var content = (body && body.apiAnonymous) ? body.apiAnonymous : '';
    cb(null, content);
  });
}

module.exports = {
  listAllRules: listAllRules,
  getRuleContent: getRuleContent,
  _get: get  // exported for unit test monkey-patching
};
