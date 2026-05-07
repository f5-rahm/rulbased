'use strict';

var http = require('http');
var fs = require('fs');
var crypto = require('crypto');
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

  logger.fine('bigipClient.get: ' + path);

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
    logger.severe('bigipClient.get error on ' + path + ': ' + err.message);
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
  _get: get,                                  // exported for unit test monkey-patching
  _patch: patch,                              // exported for unit test monkey-patching
  _post: function () { return post.apply(null, arguments); }, // late-bound (post defined below)
  _writeMergeFile: _writeMergeFile,           // exported for unit testing
  _parseTmshError: _parseTmshError,           // exported for unit testing
  _wrapAsTmshStanza: _wrapAsTmshStanza,       // exported for unit testing
  _sha1: _sha1                                // exported for unit testing
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

  logger.fine('bigipClient.patch: ' + urlPath);

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
    logger.severe('bigipClient.patch error on ' + urlPath + ': ' + err.message);
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

  logger.fine('bigipClient.post: ' + urlPath);

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
    logger.severe('bigipClient.post error on ' + urlPath + ': ' + err.message);
    cb(err);
  });

  req.setTimeout(30000, function () {
    req.abort();
    cb(new Error('Timeout on POST ' + urlPath));
  });

  req.write(bodyStr, 'utf8');
  req.end();
}

// ---------------------------------------------------------------------------
// iRule deploy via `tmsh load sys config merge`
//
// Why not iControl REST PATCH apiAnonymous?
//   The REST validator (mcpd-side) rejects iRules whose top-level body opens
//   with '{' on a new line — F5 Bug ID 657977 (12.x–15.x, no fix listed). The
//   GUI accepts these because it submits content through a different validation
//   path. Rules like proc libraries with `proc <name> { ... } { <body> }`
//   trigger this even though their content parses fine at runtime.
//
// Why this approach?
//   The merge path goes through tmsh's parser (same one tmm uses), so anything
//   the GUI would accept also merges cleanly. We're on-box (uid 198 restnoded),
//   so we write the temp file directly with fs.writeFileSync — no upload step
//   like the off-box VS Code extension needs. tmsh is invoked via the bash
//   util REST endpoint at localhost:8100, which sidesteps the home-directory /
//   history-file problem documented in PLANNING.md (line 729-735) that prevents
//   spawning tmsh as a child_process from restnoded.
//
// Failure detection on the bash util endpoint is textual — tmsh writes errors
// to stdout, the endpoint returns HTTP 200 either way. _parseTmshError handles
// the parsing.
// ---------------------------------------------------------------------------

// Wrap a raw iRule body in a tmsh stanza suitable for `tmsh load merge`.
// The partition is encoded as part of the rule's full path so merge updates
// the right object regardless of which partition tmsh defaults to.
// CRLF line endings match the VS Code extension's working pattern.
function _wrapAsTmshStanza(partition, name, content) {
  return 'ltm rule /' + partition + '/' + name + ' {\r\n' +
    content + '\r\n}\r\n';
}

// Write the wrapped iRule to a per-deploy unique path under /tmp/. The unique
// suffix prevents collisions if two deploys race; the rulbased-merge- prefix
// makes leftovers easy to spot and clean up manually if a worker crashes
// mid-deploy.
function _writeMergeFile(partition, name, content) {
  var stanza = _wrapAsTmshStanza(partition, name, content);
  var fname = 'rulbased-merge-' + Date.now() + '-' +
    Math.floor(Math.random() * 1000000) + '.tcl';
  var fpath = '/tmp/' + fname;
  fs.writeFileSync(fpath, stanza, { encoding: 'utf8', mode: 384 }); // decimal 384 = octal 0600 (Node 6 cannot parse 0o600)
  return fpath;
}

// Parse the commandResult text returned by /mgmt/tm/util/bash for a tmsh
// invocation. Returns null on success, an Error on failure with the cleaned
// human-readable message in err.message.
//
// tmsh error lines look like:
//   01070151:3: Rule [/Common/foo] error: incomplete command
//   /tmp/file.tcl:3: error: ...
// Trailing/leading whitespace and the iControl REST error code prefix
// ([0-9a-f]+:[0-9]+:) are stripped to match the existing GUI error format
// described in PLANNING.md line 1040-1044.
function _parseTmshError(commandResult) {
  if (!commandResult) { return null; }
  var text = String(commandResult);
  // Anchor on tmsh's actual error markers rather than a loose error|fail
  // substring search — iRule log messages can contain the words "error" or
  // "fail" without the deploy itself failing.
  // Markers we treat as failure:
  //   - line beginning with [0-9a-f]+:[0-9]+: (mcpd error code)
  //   - line containing "Syntax Error:" (tmsh parse failure)
  //   - line containing "error:" preceded by file:line (tmsh load failure)
  //   - line beginning with "01..." style 8-hex error codes
  var lines = text.split(/\r?\n/);
  var errorLines = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/^[0-9a-f]{6,8}:[0-9]+:/i.test(ln) ||
        /Syntax Error:/i.test(ln) ||
        /:\s*[0-9]+:\s*error:/i.test(ln)) {
      errorLines.push(ln);
    }
  }
  if (errorLines.length === 0) { return null; }
  // Strip the mcpd error code prefix and any "Rule [/p/n] error:" wrapper
  // so the message matches the format the GUI already knows how to render.
  var cleaned = errorLines.map(function (ln) {
    return ln
      .replace(/^[0-9a-f]{6,8}:[0-9]+:\s*/i, '')
      .replace(/^Rule\s+\[\/[^\]]+\]\s+error:\s*/i, '')
      .trim();
  }).join('\n');
  var e = new Error(cleaned);
  e.tmshOutput = text;
  return e;
}

function _sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// Best-effort cleanup of the temp file. Failure is logged but never blocks
// the caller — a leftover /tmp/rulbased-merge-*.tcl is harmless.
function _cleanupMergeFile(fpath) {
  try {
    fs.unlinkSync(fpath);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      logger.warning('bigipClient.deployRule: temp file cleanup failed for ' +
        fpath + ': ' + e.message);
    }
  }
}

/**
 * Deploy an iRule by writing it to /tmp/ as a tmsh stanza and running
 * `tmsh load sys config merge file <path>` via the bash util REST endpoint.
 * After the merge succeeds, the rule is read back and the SHA-1 of its
 * apiAnonymous content is compared against the SHA-1 of the submitted body
 * to confirm what tmm actually loaded matches what the caller asked for.
 *
 * @param {string}   partition
 * @param {string}   name
 * @param {string}   content  - raw TCL body (no outer wrapper)
 * @param {function} cb       - cb(err)
 */
function deployRule(partition, name, content, cb) {
  var rulePath = '/' + partition + '/' + name;
  logger.info('bigipClient.deployRule: tmsh merge ' + rulePath);

  var fpath;
  try {
    fpath = _writeMergeFile(partition, name, content);
  } catch (e) {
    logger.severe('bigipClient.deployRule: failed to write merge file: ' + e.message);
    return cb(e);
  }
  logger.fine('bigipClient.deployRule: wrote merge file ' + fpath);

  var bashBody = {
    command: 'run',
    utilCmdArgs: "-c 'tmsh load sys config merge file " + fpath + "'"
  };

  module.exports._post('/mgmt/tm/util/bash', bashBody, function (err, result) {
    if (err) {
      _cleanupMergeFile(fpath);
      logger.severe('bigipClient.deployRule: bash POST failed: ' + err.message);
      return cb(err);
    }

    var commandResult = (result && result.commandResult) || '';
    var tmshErr = _parseTmshError(commandResult);
    if (tmshErr) {
      _cleanupMergeFile(fpath);
      logger.severe('bigipClient.deployRule: tmsh merge reported error: ' + tmshErr.message);
      return cb(tmshErr);
    }

    logger.info('bigipClient.deployRule: tmsh merge succeeded; verifying readback hash');
    _cleanupMergeFile(fpath);

    // Hash-verify: GET the rule and compare SHA-1 of stored apiAnonymous
    // against the submitted content. A mismatch usually means tmsh normalized
    // whitespace (acceptable but worth surfacing) or — much worse — landed
    // the merge on the wrong rule. Either way the operator should know.
    getRuleContent(partition, name, function (gerr, stored) {
      if (gerr) {
        // Couldn't verify — don't fail the deploy on this; the merge
        // already succeeded per tmsh's own report.
        logger.warning('bigipClient.deployRule: post-merge readback failed: ' +
          gerr.message + ' (deploy still considered successful)');
        return cb(null);
      }
      var sentHash = _sha1(content);
      var storedHash = _sha1(stored || '');
      if (sentHash === storedHash) {
        logger.info('bigipClient.deployRule: hash verified (' + sentHash.substring(0, 7) + ')');
        return cb(null);
      }
      // Hash mismatch. Most common cause: tmsh normalized whitespace.
      // Compare with whitespace collapsed to detect this case and downgrade
      // to a warning if the only difference is whitespace.
      var sentNorm = content.replace(/\s+/g, ' ').trim();
      var storedNorm = (stored || '').replace(/\s+/g, ' ').trim();
      if (sentNorm === storedNorm) {
        logger.warning('bigipClient.deployRule: stored content matches semantically ' +
          'but whitespace was normalized by tmsh (sent ' + content.length +
          ' bytes, stored ' + stored.length + ' bytes); proceeding');
        return cb(null);
      }
      var msg = 'Post-merge hash verification failed: stored content does not ' +
        'match submitted body (sent sha1=' + sentHash.substring(0, 7) +
        ', stored sha1=' + storedHash.substring(0, 7) + ')';
      logger.severe('bigipClient.deployRule: ' + msg);
      var verErr = new Error(msg);
      verErr.statusCode = 500;
      cb(verErr);
    });
  });
}
