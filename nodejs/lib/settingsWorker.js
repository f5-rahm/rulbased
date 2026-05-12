'use strict';

var crypto = require('crypto');
var settings = require('./settings');
var notifier = require('./notifier');
var logger = require('./logger');

var WORKER_URI_PATH = 'shared/rulbased/settings';

// ---------------------------------------------------------------------------
// Webhook test receiver — in-memory single-slot capture (Phase 9.3)
// ---------------------------------------------------------------------------
var _webhookCapture = null;
var _CAPTURE_EXPIRY = 300000; // 5 minutes

/**
 * Settings Worker
 *
 * GET  /mgmt/shared/rulbased/settings               - read current settings
 * GET  /mgmt/shared/rulbased/settings/test-syslog   - fire a test syslog entry
 * GET  /mgmt/shared/rulbased/settings/test-webhook  - fire a test webhook
 * PUT  /mgmt/shared/rulbased/settings               - update settings
 *
 * Note: test-webhook is a GET (not POST) because restnoded rejects bodyless
 * POSTs at the framework level before onPost is called.  A GET is correct
 * here anyway — it has no body semantics and is idempotent in the sense that
 * it does not mutate any stored state.
 */
function SettingsWorker() {
  this.WORKER_URI_PATH = WORKER_URI_PATH;
  this.isPublic = true;
  this.isPassThrough = true;
}

SettingsWorker.prototype.onGet = function (restOperation) {
  var uri = restOperation.getUri();
  var pathname = uri ? (uri.pathname || '') : '';

  // GET /settings/test-syslog
  if (pathname.indexOf('test-syslog') !== -1) {
    logger.info('SettingsWorker: test-syslog triggered');
    notifier.testSyslog(function (err) {
      var result = err
        ? { ok: false, error: err.message }
        : { ok: true, message: 'Entries written — check: grep rulbased /var/log/ltm && grep rulbased /var/log/audit' };
      logger.info('SettingsWorker: test-syslog result: ' + JSON.stringify(result));
      restOperation.setStatusCode(200);
      restOperation.setBody(result);
      restOperation.complete();
    });
    return;
  }

  // GET /settings/test-webhook
  if (pathname.indexOf('test-webhook') !== -1) {
    logger.info('SettingsWorker: test-webhook triggered');
    notifier.testWebhook(function (err) {
      var result = err
        ? { ok: false, error: err.message }
        : { ok: true };
      logger.info('SettingsWorker: test-webhook result: ' + JSON.stringify(result));
      restOperation.setStatusCode(200);
      restOperation.setBody(result);
      restOperation.complete();
    });
    return;
  }

  // GET /settings/test-capture — generates a test payload locally (no HTTP round-trip)
  if (pathname.indexOf('test-capture') !== -1 && pathname.indexOf('webhook-test-receiver') === -1) {
    logger.info('SettingsWorker: test-capture triggered');
    var capture = notifier.generateTestCapture();
    restOperation.setStatusCode(200);
    restOperation.setBody({ captured: true, data: capture });
    restOperation.complete();
    return;
  }

  // GET /settings/webhook-test-receiver/last
  if (pathname.indexOf('webhook-test-receiver/last') !== -1) {
    if (!settings.getAll().webhookReceiverEnabled) {
      restOperation.setStatusCode(404);
      restOperation.setBody({ error: 'Webhook test receiver is disabled' });
      restOperation.complete();
      return;
    }
    if (!_webhookCapture || (Date.now() - new Date(_webhookCapture.receivedAt).getTime()) > _CAPTURE_EXPIRY) {
      restOperation.setStatusCode(200);
      restOperation.setBody({ captured: false });
      restOperation.complete();
      return;
    }
    restOperation.setStatusCode(200);
    restOperation.setBody({ captured: true, data: _webhookCapture });
    restOperation.complete();
    return;
  }

  // GET /settings
  restOperation.setStatusCode(200);
  restOperation.setBody(settings.getAll());
  restOperation.complete();
};

SettingsWorker.prototype.onPut = function (restOperation) {
  var body = restOperation.getBody() || {};
  try {
    settings.update(body);
    restOperation.setStatusCode(200);
    restOperation.setBody(settings.getAll());
    restOperation.complete();
  } catch (e) {
    logger.severe('SettingsWorker.onPut: ' + e.message);
    restOperation.setStatusCode(400);
    restOperation.setBody({ error: e.message });
    restOperation.complete();
  }
};

// ---------------------------------------------------------------------------
// POST — webhook test receiver capture
// ---------------------------------------------------------------------------
SettingsWorker.prototype.onPost = function (restOperation) {
  var uri = restOperation.getUri();
  var pathname = uri ? (uri.pathname || '') : '';

  // POST /settings/webhook-test-receiver
  if (pathname.indexOf('webhook-test-receiver') !== -1) {
    if (!settings.getAll().webhookReceiverEnabled) {
      restOperation.setStatusCode(404);
      restOperation.setBody({ error: 'Webhook test receiver is disabled' });
      restOperation.complete();
      return;
    }
    var body = restOperation.getBody();
    var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    var headers = {};
    try {
      var rawHeaders = restOperation.getHeaders ? restOperation.getHeaders() : {};
      if (rawHeaders) { headers = JSON.parse(JSON.stringify(rawHeaders)); }
    } catch (e) { /* best effort */ }

    var sig = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'] || '';
    var verified = false;
    if (sig) {
      var secret = settings.getAll().webhookSecret || '';
      if (secret) {
        var expected = 'sha256=' + crypto.createHmac('sha256', secret)
          .update(bodyStr, 'utf8').digest('hex');
        verified = (sig === expected);
      }
    }

    _webhookCapture = {
      receivedAt: new Date().toISOString(),
      headers: headers,
      body: body,
      signatureHeader: sig,
      signatureVerified: verified
    };

    logger.info('SettingsWorker: webhook test receiver captured request');
    restOperation.setStatusCode(200);
    restOperation.setBody({ ok: true });
    restOperation.complete();
    return;
  }

  restOperation.setStatusCode(404);
  restOperation.setBody({ error: 'Not found' });
  restOperation.complete();
};

// ---------------------------------------------------------------------------
// DELETE — clear webhook test receiver capture
// ---------------------------------------------------------------------------
SettingsWorker.prototype.onDelete = function (restOperation) {
  var uri = restOperation.getUri();
  var pathname = uri ? (uri.pathname || '') : '';

  if (pathname.indexOf('webhook-test-receiver/last') !== -1) {
    _webhookCapture = null;
    restOperation.setStatusCode(200);
    restOperation.setBody({ ok: true });
    restOperation.complete();
    return;
  }

  restOperation.setStatusCode(404);
  restOperation.setBody({ error: 'Not found' });
  restOperation.complete();
};

module.exports = SettingsWorker;
