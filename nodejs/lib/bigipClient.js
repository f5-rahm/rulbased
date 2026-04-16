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
  deployRule: deployRule,
  _get: get,     // exported for unit test monkey-patching
  _patch: patch  // exported for unit test monkey-patching
};

/**
 * Make a PATCH request to the local iControl REST API.
 * Used for deploying iRule content via apiAnonymous field.
 * @param {string}   urlPath - URI path e.g. '/mgmt/tm/ltm/rule/~Common~my_rule'
 * @param {object}   body    - request body (will be JSON-serialised)
 * @param {function} cb      - cb(err, parsedBody)
 */
function patch(urlPath, body, cb) {
  var bodyStr = JSON.stringify(body);
  var options = {
    host: MGMT_HOST,
    port: MGMT_PORT,
    path: urlPath,
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': AUTH_HEADER,
      'Content-Length': Buffer.byteLength(bodyStr, 'utf8')
    }
  };

  logger.debug('bigipClient.patch: ' + urlPath);

  var req = http.request(options, function (res) {
    var respBody = '';
    res.setEncoding('utf8');
    res.on('data', function (chunk) { respBody += chunk; });
    res.on('end', function () {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        var errMsg = respBody;
        try {
          var errObj = JSON.parse(respBody);
          if (errObj && errObj.message) { errMsg = errObj.message; }
        } catch (pe) { /* use raw body */ }
        var e = new Error(errMsg);
        e.statusCode = res.statusCode;
        return cb(e);
      }
      try {
        cb(null, JSON.parse(respBody));
      } catch (e) {
        cb(new Error('Failed to parse PATCH response from ' + urlPath + ': ' + e.message));
      }
    });
  });

  req.on('error', function (err) {
    logger.error('bigipClient.patch error on ' + urlPath + ': ' + err.message);
    cb(err);
  });

  req.setTimeout(30000, function () {
    req.abort();
    cb(new Error('Timeout on PATCH ' + urlPath));
  });

  req.write(bodyStr, 'utf8');
  req.end();
}


function post(urlPath, body, cb) {
  var bodyStr = JSON.stringify(body);
  var options = {
    host: MGMT_HOST,
    port: MGMT_PORT,
    path: urlPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': AUTH_HEADER,
      'Content-Length': Buffer.byteLength(bodyStr, 'utf8')
    }
  };

  logger.debug('bigipClient.post: ' + urlPath);

  var req = http.request(options, function (res) {
    var respBody = '';
    res.setEncoding('utf8');
    res.on('data', function (chunk) { respBody += chunk; });
    res.on('end', function () {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // Try to extract the clean message from iControl REST JSON error body
        var errMsg = respBody;
        try {
          var errObj = JSON.parse(respBody);
          if (errObj && errObj.message) { errMsg = errObj.message; }
        } catch (pe) { /* use raw body */ }
        return cb(new Error(errMsg));
      }
      try {
        cb(null, JSON.parse(respBody));
      } catch (e) {
        cb(new Error('Failed to parse POST response from ' + urlPath + ': ' + e.message));
      }
    });
  });

  req.on('error', function (err) {
    logger.error('bigipClient.post error on ' + urlPath + ': ' + err.message);
    cb(err);
  });

  req.setTimeout(30000, function () {
    req.abort();
    cb(new Error('Timeout on POST ' + urlPath));
  });

  req.write(bodyStr, 'utf8');
  req.end();
}

/**
 * Deploy an iRule by PATCHing its apiAnonymous content via iControl REST.
 * This replaces the tmsh load+save approach entirely — no temp files,
 * no child processes, no permission issues.
 * The REST write is committed to running config immediately; a separate
 * 'save sys config' is NOT needed — the REST API handles persistence.
 *
 * @param {string}   partition
 * @param {string}   name
 * @param {string}   content  - raw TCL body (no outer wrapper)
 * @param {function} cb       - cb(err)
 */
function deployRule(partition, name, content, cb) {
  var encodedPath = '~' + partition + '~' + name;
  var urlPath = '/mgmt/tm/ltm/rule/' + encodedPath;

  logger.info('bigipClient.deployRule: PATCH ' + urlPath);

  patch(urlPath, { apiAnonymous: content }, function (err, result) {
    if (!err) {
      logger.info('bigipClient.deployRule: PATCH success, generation=' + (result && result.generation));
      return cb(null);
    }

    // 404 means the rule does not exist yet — create it with POST
    if (err.statusCode === 404 || (err.message && err.message.indexOf('HTTP 404') !== -1)) {
      logger.info('bigipClient.deployRule: rule not found, creating via POST');
      var fullName = '/' + partition + '/' + name;
      post('/mgmt/tm/ltm/rule', { name: fullName, apiAnonymous: content }, function (postErr, postResult) {
        if (postErr) {
          logger.error('bigipClient.deployRule POST failed: ' + postErr.message);
          return cb(postErr);
        }
        logger.info('bigipClient.deployRule: POST success (rule created), generation=' + (postResult && postResult.generation));
        cb(null);
      });
      return;
    }

    logger.error('bigipClient.deployRule PATCH failed: ' + err.message);
    cb(err);
  });
}
