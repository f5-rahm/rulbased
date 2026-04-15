'use strict';

var settings = require('./settings');
var logger = require('./logger');

var WORKER_URI_PATH = 'shared/irule-versioner/settings';

/**
 * Settings Worker
 *
 * GET  /mgmt/shared/irule-versioner/settings  - read current settings
 * PUT  /mgmt/shared/irule-versioner/settings  - update settings
 */
function SettingsWorker() {
  this.WORKER_URI_PATH = WORKER_URI_PATH;
  this.isPublic = true;
  this.isPassThrough = false;
}

SettingsWorker.prototype.onGet = function (restOperation) {
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
