'use strict';

var fs = require('fs');
var path = require('path');
var logger = require('./logger');

/**
 * settings.js
 *
 * Holds global extension settings in memory, with persistence to
 * settings.json inside the data directory.
 *
 * Settings are written by the iApps LX block's inputProperties on
 * BINDING, and can also be updated directly via the settings REST worker.
 *
 * schemaVersion is managed here alongside user settings.  It is an integer
 * written by migrations.js and read on startup.  Missing key → treated as 0
 * (pre-Phase-6 install).  Users should not edit this field manually; if they
 * do and corrupt it, missing/NaN is handled gracefully by treating it as 0
 * (safe: re-runs migrations, which are idempotent).
 */

var _defaults = {
  dataDirectory: '/var/config/rest/iapps/rulbased/data',
  pollIntervalSeconds: 300,
  syslogEnabled: true,
  webhookUrl: '',
  webhookSecret: '',
  webhookOnDrift: false,
  iruleLinks: true,
  tclManPageLinks: true,
  debugMode: false,
  dashboardAuditLimit: 15,
  hideSystemRules: true,
  theme: 'auto',
  lintMode: 'warn',
  webhookReceiverEnabled: false,
  lintRules: {},
  schemaVersion: 0
};

var _current = JSON.parse(JSON.stringify(_defaults));

function getAll() {
  return JSON.parse(JSON.stringify(_current));
}

function getDataDir() {
  return _current.dataDirectory;
}

function update(values) {
  var allowed = Object.keys(_defaults);
  Object.keys(values).forEach(function (k) {
    if (allowed.indexOf(k) === -1) {
      throw new Error('Unknown setting: ' + k);
    }
    if (k === 'theme') {
      var t = values[k];
      if (t !== 'light' && t !== 'dark' && t !== 'auto') {
        throw new Error('theme must be one of: light, dark, auto');
      }
    }
    if (k === 'lintMode') {
      var lm = values[k];
      if (lm !== 'strict' && lm !== 'warn' && lm !== 'off') {
        throw new Error('lintMode must be one of: strict, warn, off');
      }
    }
    _current[k] = values[k];
  });
  _persist();
}

function load(dataDir) {
  var settingsFile = path.join(dataDir, 'settings.json');
  try {
    var raw = fs.readFileSync(settingsFile, { encoding: 'utf8' });
    var saved = JSON.parse(raw);
    Object.keys(saved).forEach(function (k) {
      if (_defaults.hasOwnProperty(k)) {
        _current[k] = saved[k];
      }
    });
    logger.info('settings: loaded from ' + settingsFile);
  } catch (e) {
    logger.fine('settings: no settings file found, using defaults');
  }
}

function _persist() {
  var settingsFile = path.join(_current.dataDirectory, 'settings.json');
  fs.writeFile(settingsFile, JSON.stringify(_current, null, 2), { encoding: 'utf8' }, function (err) {
    if (err) { logger.warning('settings: failed to persist: ' + err.message); }
  });
}

module.exports = { getAll: getAll, getDataDir: getDataDir, update: update, load: load };
