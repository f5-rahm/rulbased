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
 */

var _defaults = {
  dataDirectory: '/var/config/rest/iapps/irule-versioner/data',
  pollIntervalSeconds: 300,
  syslogEnabled: true,
  webhookUrl: ''
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
    // No settings file yet — use defaults; will be written on first update
    logger.debug('settings: no settings file found, using defaults');
  }
}

function _persist() {
  var settingsFile = path.join(_current.dataDirectory, 'settings.json');
  fs.writeFile(settingsFile, JSON.stringify(_current, null, 2), { encoding: 'utf8' }, function (err) {
    if (err) { logger.warn('settings: failed to persist: ' + err.message); }
  });
}

module.exports = { getAll: getAll, getDataDir: getDataDir, update: update, load: load };
