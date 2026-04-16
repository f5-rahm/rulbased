'use strict';

var settings = require('./settings');
var notifier = require('./notifier');
var logger = require('./logger');

var WORKER_URI_PATH = 'shared/irule-versioner/settings';

/**
 * Settings Worker
 *
 * GET  /mgmt/shared/irule-versioner/settings               - read current settings
 * GET  /mgmt/shared/irule-versioner/settings/test-syslog   - fire a test syslog entry
 * GET  /mgmt/shared/irule-versioner/settings/test-webhook  - fire a test webhook
 * PUT  /mgmt/shared/irule-versioner/settings               - update settings
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
        : { ok: true, message: 'Entries written — check: grep irule-versioner /var/log/ltm && grep irule-versioner /var/log/audit' };
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
    logger.error('SettingsWorker.onPut: ' + e.message);
    restOperation.setStatusCode(400);
    restOperation.setBody({ error: e.message });
    restOperation.complete();
  }
};

module.exports = SettingsWorker;
