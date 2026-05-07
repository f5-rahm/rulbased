'use strict';

/**
 * logger.js
 *
 * Thin wrapper around restnoded's f5-logger module.
 *
 * Background: previous versions of this file checked for a global `logger`
 * variable (`typeof logger !== 'undefined'`). That global does not exist in
 * the iControl LX framework — it's an attribute of worker instances
 * (`self.logger`, accessed inside RestWorker methods), not a global. The
 * undefined check therefore always failed and silently fell through to
 * `console`, whose output goes to /var/tmp/restnoded.out rather than the
 * canonical /var/log/restnoded/restnoded.log. The result was that every log
 * line from helper modules — bigipClient.js, versionStore.js, notifier.js,
 * etc. — was effectively invisible.
 *
 * The documented API for helper modules is `require('f5-logger').getInstance()`.
 * This is what F5's own AS3 codebase does (see f5-appsvcs-extension/src/lib/log.js)
 * and what clouddocs documents at:
 * https://clouddocs.f5.com/products/iapp/iapp-lx/.../create_icontrol_extension.html
 *
 * Method names match f5-logger and the per-worker `self.logger` exactly:
 *   info     - operational events
 *   warning  - recoverable problems (note: NOT "warn" — that's a Node.js
 *              console convention, not the f5-logger convention)
 *   severe   - errors that should page on, in production logging pipelines
 *   fine     - debug-level detail, suppressed by default at the framework level
 *   config   - lifecycle/config events (used by RestWorker registration noise)
 *
 * Using the same method names everywhere means workers (`self.logger.severe`)
 * and helper modules (`logger.severe`) produce identically-formatted lines,
 * and a search for `severe:` in the log surfaces every error from every layer.
 *
 * Outside restnoded (e.g. unit tests), require('f5-logger') will throw
 * MODULE_NOT_FOUND. The fallback uses console with a date-prefixed format
 * matching the in-restnoded format, mirroring AS3's pattern.
 */

var PREFIX = '[Rülbased] ';

// Acquire the f5-logger singleton at require-time. If we're not inside
// restnoded (i.e. f5-logger isn't on the resolution path), fall back to a
// console-backed shim that produces the same line shape restnoded does.
var _logger;
try {
  _logger = require('f5-logger').getInstance();
} catch (e) {
  if (!e || e.code !== 'MODULE_NOT_FOUND') {
    // Surface anything other than the expected "not running in restnoded"
    // case, then keep going with the fallback rather than crashing the
    // first time anyone calls a log function.
    try { console.error('[Rülbased] logger init failed: ' + e.message); }
    catch (ce) { /* ignore */ }
  }
  _logger = _consoleFallback();
}

function _consoleFallback() {
  // Matches the line format restnoded produces for f5-logger output:
  //   "Thu, 07 May 2026 21:11:34 GMT - info: <message>"
  // Pattern adapted from F5 AS3 src/lib/log.js — same shape, lets a single
  // grep work against both restnoded.log lines and console output during
  // unit tests.
  var levels = ['info', 'warning', 'severe', 'fine', 'config'];
  var shim = {};
  levels.forEach(function (level) {
    shim[level] = function (msg) {
      // eslint-disable-next-line no-console
      console.log((new Date()).toUTCString() + ' - ' + level + ': ' + msg);
    };
  });
  return shim;
}

function _emit(level, msg) {
  var L = _logger;
  if (typeof L[level] === 'function') {
    L[level](PREFIX + msg);
    return;
  }
  // Defensive: should never happen with a real f5-logger or our fallback,
  // but if some future restnoded build drops a level, fall back to .info
  // rather than throwing.
  if (typeof L.info === 'function') {
    L.info(PREFIX + '(' + level + ') ' + msg);
  }
}

function info(msg)    { _emit('info',    msg); }
function warning(msg) { _emit('warning', msg); }
function severe(msg)  { _emit('severe',  msg); }
function fine(msg)    { _emit('fine',    msg); }
function config(msg)  { _emit('config',  msg); }

module.exports = {
  info:    info,
  warning: warning,
  severe:  severe,
  fine:    fine,
  config:  config,
  // Exposed for unit tests that want to verify which underlying logger
  // was selected without invoking a log call.
  _underlying: function () { return _logger; }
};
