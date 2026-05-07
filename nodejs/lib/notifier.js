'use strict';

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var os = require('os');
var logger = require('./logger');
var settings = require('./settings');

/**
 * notifier.js
 *
 * Fires syslog and/or webhook notifications on deploy, rollback, and
 * external-change-detected events.
 *
 * Syslog: emitted via logger(1) (Unix syslog utility) — writes to /var/log/ltm
 *   via local0.notice. tmsh has no 'log' subcommand; logger(1) is the correct
 *   tool on BIG-IP. Tag is 'rulbased' for easy grepping.
 * Webhook: HTTP/HTTPS POST when webhookUrl is set, with optional
 *   HMAC-SHA256 X-Hub-Signature-256 header when webhookSecret is set.
 *   Retries up to 3 times with 5s async backoff on failure.
 *   Total failure is logged to audit; intermediate failures logged only
 *   when debugMode is enabled.
 *
 * Call signature:
 *   notifier.emit(eventObj, dataDir, appendAuditFn)
 *
 * eventObj fields (all strings unless noted):
 *   action    - 'deploy' | 'rollback' | 'external-change-detected'
 *   rule      - full path e.g. '/Common/my_rule'
 *   fromHash  - previous hash (may be null)
 *   toHash    - new hash
 *   author    - username
 *   reason    - commit message / reason string
 *   timestamp - ISO 8601 string
 *
 * dataDir and appendAuditFn are only needed for webhook failure audit
 * logging; both are optional (pass null to suppress audit on failure).
 */

var _RETRY_ATTEMPTS = 3;
var _RETRY_DELAY_MS = 5000;

/**
 * Main entry point.  Fire-and-forget — callers do not await this.
 */
function emit(eventObj, dataDir, appendAuditFn) {
  var cfg = settings.getAll();
  var device = os.hostname();

  // Build the canonical payload used for both syslog message and webhook body
  var payload = {
    event:     eventObj.action    || 'unknown',
    rule:      eventObj.rule      || '',
    fromHash:  eventObj.fromHash  || null,
    toHash:    eventObj.toHash    || null,
    author:    eventObj.author    || 'unknown',
    reason:    eventObj.reason    || '',
    timestamp: eventObj.timestamp || new Date().toISOString(),
    device:    device
  };

  if (cfg.syslogEnabled) {
    _emitSyslog(payload);
  }

  // For drift events, webhook fires only when webhookOnDrift is explicitly enabled.
  // For deploy/rollback events, webhook fires whenever a URL is configured.
  var isDrift = !!(eventObj.isDrift);
  var webhookEnabled = cfg.webhookUrl && cfg.webhookUrl.trim().length > 0 &&
    (!isDrift || cfg.webhookOnDrift);

  if (webhookEnabled) {
    _emitWebhook(payload, cfg.webhookUrl.trim(), cfg.webhookSecret || '',
                 dataDir, appendAuditFn, 1);
  }
}

/**
 * Test-fire a webhook with a synthetic payload.
 * cb(err) — err is null on success, Error on failure.
 */
function testWebhook(cb) {
  var cfg = settings.getAll();
  if (!cfg.webhookUrl || cfg.webhookUrl.trim().length === 0) {
    return cb(new Error('No webhook URL configured'));
  }
  var payload = {
    event:     'test',
    rule:      '/Common/test-rule',
    fromHash:  null,
    toHash:    'abc1234',
    author:    'admin',
    reason:    'Test webhook from Rulbased settings',
    timestamp: new Date().toISOString(),
    device:    os.hostname()
  };
  _sendWebhookOnce(payload, cfg.webhookUrl.trim(), cfg.webhookSecret || '', cb);
}

// ---------------------------------------------------------------------------
// Syslog
// ---------------------------------------------------------------------------

// Audit-class actions that should appear in /var/log/audit in addition to
// /var/log/ltm.  The 'test' event is excluded — it is a diagnostic fire,
// not a real configuration change.
var _AUDIT_ACTIONS = { 'deploy': true, 'rollback': true, 'external-change-detected': true };

function _emitSyslog(payload) {
  var childProcess = require('child_process');

  // --- /var/log/ltm entry (operational) ---
  // local0.notice — routed to /var/log/ltm by syslog-ng filter(f_local0).
  var ltmMsg = 'rulbased: [' + payload.event + ']' +
    ' rule=' + payload.rule +
    (payload.fromHash ? ' from=' + payload.fromHash : '') +
    ' to=' + (payload.toHash || 'unknown') +
    ' author=' + payload.author +
    ' reason=' + payload.reason.replace(/['"]/g, '');

  childProcess.execFile('/usr/bin/logger',
    ['-p', 'local0.notice', '-t', 'rulbased', ltmMsg],
    { timeout: 5000 },
    function (err, stdout, stderr) {
      if (err) {
        logger.warning('notifier: /var/log/ltm emission failed: ' + err.message +
          (stderr ? ' stderr=' + stderr.trim() : ''));
      } else {
        logger.info('notifier: /var/log/ltm entry written for ' + payload.event +
          ' on ' + payload.rule);
      }
    }
  );

  // --- /var/log/audit entry (security/compliance) ---
  // syslog-ng f_audit filter: facility(local0) AND message("AUDIT").
  // Both conditions must be true — local0 facility, and "AUDIT" in the body.
  // local3 routes to /var/log/asm; local0 + AUDIT token is the audit path.
  // Format mirrors native BIG-IP audit entries: "AUDIT - user <u> - RAW: ..."
  if (_AUDIT_ACTIONS[payload.event]) {
    var auditMsg = 'AUDIT - user ' + payload.author +
      ' - RAW: rulbased:' +
      ' action=' + payload.event +
      ' rule=' + payload.rule +
      (payload.fromHash ? ' from=' + payload.fromHash : '') +
      ' to=' + (payload.toHash || 'unknown') +
      ' reason=' + payload.reason.replace(/['"]/g, '');

    childProcess.execFile('/usr/bin/logger',
      ['-p', 'local0.info', '-t', 'rulbased', auditMsg],
      { timeout: 5000 },
      function (err, stdout, stderr) {
        if (err) {
          logger.warning('notifier: /var/log/audit emission failed: ' + err.message +
            (stderr ? ' stderr=' + stderr.trim() : ''));
        } else {
          logger.info('notifier: /var/log/audit entry written for ' + payload.event +
            ' on ' + payload.rule);
        }
      }
    );
  }
}

/**
 * Test syslog emission — fires one entry to /var/log/ltm and one to
 * /var/log/audit so both routing paths can be verified in a single call.
 * cb(err) — err null if both succeed, Error describing the first failure.
 */
function testSyslog(cb) {
  var childProcess = require('child_process');
  var done = false;

  function finish(err) {
    if (done) { return; }
    done = true;
    cb(err || null);
  }

  // /var/log/ltm
  childProcess.execFile('/usr/bin/logger',
    ['-p', 'local0.notice', '-t', 'rulbased',
      'rulbased: [test] syslog test from Rulbased settings'],
    { timeout: 5000 },
    function (err, stdout, stderr) {
      if (err) {
        return finish(new Error('/var/log/ltm: ' + err.message +
          (stderr ? ' stderr=' + stderr.trim() : '')));
      }

      // /var/log/audit
      childProcess.execFile('/usr/bin/logger',
        ['-p', 'local0.info', '-t', 'rulbased',
          'AUDIT - user admin - RAW: rulbased: action=test reason=syslog test from Rulbased settings'],
        { timeout: 5000 },
        function (err2, stdout2, stderr2) {
          if (err2) {
            return finish(new Error('/var/log/audit: ' + err2.message +
              (stderr2 ? ' stderr=' + stderr2.trim() : '')));
          }
          finish(null);
        }
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * Fire webhook with retry.  attempt is 1-based.
 */
function _emitWebhook(payload, url, secret, dataDir, appendAuditFn, attempt) {
  _sendWebhookOnce(payload, url, secret, function (err) {
    if (!err) {
      logger.fine('notifier: webhook delivered on attempt ' + attempt);
      return;
    }

    var cfg = settings.getAll();

    if (cfg.debugMode) {
      logger.warning('notifier: webhook attempt ' + attempt + ' failed: ' + err.message);
    }

    if (attempt < _RETRY_ATTEMPTS) {
      setTimeout(function () {
        _emitWebhook(payload, url, secret, dataDir, appendAuditFn, attempt + 1);
      }, _RETRY_DELAY_MS);
      return;
    }

    // All attempts exhausted
    var failMsg = 'Webhook delivery failed after ' + _RETRY_ATTEMPTS +
      ' attempts: ' + err.message;
    logger.severe('notifier: ' + failMsg);

    // Write failure to audit log so operators can see it
    if (dataDir && appendAuditFn) {
      appendAuditFn(dataDir, {
        ts:     new Date().toISOString(),
        author: 'system',
        action: 'webhook-failed',
        rule:   payload.rule,
        reason: failMsg
      }, function () {});
    }
  });
}

/**
 * Send a single webhook HTTP/HTTPS POST.
 * cb(err) — err null on 2xx, Error otherwise.
 */
function _sendWebhookOnce(payload, url, secret, cb) {
  var body;
  try {
    body = JSON.stringify(payload);
  } catch (e) {
    return cb(new Error('Failed to serialise payload: ' + e.message));
  }

  var parsed;
  try {
    parsed = _parseUrl(url);
  } catch (e) {
    return cb(new Error('Invalid webhook URL: ' + e.message));
  }

  var headers = {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body, 'utf8').toString(),
    'User-Agent':     'rulbased/1.0'
  };

  if (secret && secret.length > 0) {
    var sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    headers['X-Hub-Signature-256'] = sig;
  }

  var options = {
    hostname: parsed.hostname,
    port:     parsed.port,
    path:     parsed.path,
    method:   'POST',
    headers:  headers
  };

  var transport = (parsed.protocol === 'https:') ? https : http;

  var req = transport.request(options, function (res) {
    // Drain the response body — required so the socket is released
    res.on('data', function () {});
    res.on('end', function () {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cb(null);
      } else {
        cb(new Error('HTTP ' + res.statusCode));
      }
    });
  });

  req.on('error', function (err) {
    cb(new Error('Request error: ' + err.message));
  });

  req.setTimeout(10000, function () {
    req.abort();
    cb(new Error('Request timed out after 10s'));
  });

  req.write(body, 'utf8');
  req.end();
}

/**
 * Minimal URL parser — avoids url.parse() deprecation warnings while
 * remaining compatible with Node 6 (which has url.parse but not URL class).
 * Returns { protocol, hostname, port, path }.
 */
function _parseUrl(urlStr) {
  // Node 6 has url.parse — use it; it's not deprecated there
  var urlMod = require('url');
  var parsed = urlMod.parse(urlStr);
  if (!parsed.hostname) {
    throw new Error('Could not parse hostname from: ' + urlStr);
  }
  var defaultPort = (parsed.protocol === 'https:') ? 443 : 80;
  return {
    protocol: parsed.protocol || 'http:',
    hostname: parsed.hostname,
    port:     parsed.port ? parseInt(parsed.port, 10) : defaultPort,
    path:     (parsed.pathname || '/') + (parsed.search || '')
  };
}

module.exports = { emit: emit, testWebhook: testWebhook, testSyslog: testSyslog };
