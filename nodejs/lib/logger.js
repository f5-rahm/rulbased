'use strict';

/**
 * logger.js
 *
 * Thin wrapper around restnoded's built-in logger.
 * restnoded injects a global 'logger' object; if it's not present
 * (e.g. during unit testing outside restnoded), fall back to console.
 *
 * All log lines are prefixed with [irule-versioner] so they're easy
 * to grep in /var/log/restnoded/restnoded.log.
 */

var PREFIX = '[irule-versioner] ';

function _getLogger() {
  // restnoded provides a global logger; outside that environment use console
  if (typeof logger !== 'undefined' && logger && typeof logger.info === 'function') {
    return logger;  // eslint-disable-line no-undef
  }
  return console;
}

function info(msg) {
  _getLogger().info(PREFIX + msg);
}

function warn(msg) {
  _getLogger().warning ? _getLogger().warning(PREFIX + msg) : _getLogger().warn(PREFIX + msg);
}

function error(msg) {
  _getLogger().error(PREFIX + msg);
}

function debug(msg) {
  if (_getLogger().fine) {
    _getLogger().fine(PREFIX + msg);
  }
  // debug is intentionally quiet on console to avoid noise during tests
}

module.exports = { info: info, warn: warn, error: error, debug: debug };
