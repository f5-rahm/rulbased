'use strict';

var fs = require('fs');
var path = require('path');
var logger = require('./logger');

var WORKER_URI_PATH = 'shared/irule-versioner/ui';

var PRESENTATION_DIR = '/var/config/rest/iapps/irule-versioner/presentation';

var MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml'
};

/**
 * UI Worker
 *
 * Serves static files from the presentation/ directory via restnoded,
 * bypassing Apache entirely. This allows the full-page app.html to be
 * accessed with Basic auth (no browser session required) at:
 *
 *   https://<bigip>/mgmt/shared/irule-versioner/ui
 *     -> serves presentation/app.html
 *
 *   https://<bigip>/mgmt/shared/irule-versioner/ui/app.html
 *     -> serves presentation/app.html
 *
 *   https://<bigip>/mgmt/shared/irule-versioner/ui/vendor/codemirror.min.js
 *     -> serves presentation/vendor/codemirror.min.js
 *
 * isPassThrough = true so all sub-paths route here.
 */
function UiWorker() {
  this.WORKER_URI_PATH = WORKER_URI_PATH;
  this.isPublic = true;
  this.isPassThrough = true;
}

UiWorker.prototype.onStart = function (success) {
  this.logger.info('[irule-versioner] UiWorker started, serving from ' + PRESENTATION_DIR);
  success();
};

UiWorker.prototype.onGet = function (restOperation) {
  var uri      = restOperation.getUri();
  var pathname = uri ? (uri.pathname || '') : '';

  // Strip the worker base path to get the relative file path
  var prefixes = [
    '/mgmt/shared/irule-versioner/ui',
    '/shared/irule-versioner/ui'
  ];

  var relative = pathname;
  for (var i = 0; i < prefixes.length; i++) {
    if (pathname.indexOf(prefixes[i]) === 0) {
      relative = pathname.slice(prefixes[i].length);
      break;
    }
  }

  // Default to app.html when no file specified
  relative = relative.replace(/^\/+/, '') || 'app.html';

  // Security: prevent path traversal — reject any segment containing '..'
  var segments = relative.split('/');
  for (var j = 0; j < segments.length; j++) {
    if (segments[j] === '..' || segments[j] === '.') {
      restOperation.setStatusCode(400);
      restOperation.setBody({ error: 'Invalid path' });
      restOperation.complete();
      return;
    }
  }

  var filePath = path.join(PRESENTATION_DIR, relative);
  var ext      = path.extname(filePath).toLowerCase();
  var mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  logger.debug('UiWorker: serving ' + filePath);

  fs.readFile(filePath, function (err, data) {
    if (err) {
      if (err.code === 'ENOENT') {
        restOperation.setStatusCode(404);
        restOperation.setBody({ error: 'File not found: ' + relative });
      } else {
        logger.error('UiWorker: readFile error: ' + err.message);
        restOperation.setStatusCode(500);
        restOperation.setBody({ error: 'Internal error reading file' });
      }
      restOperation.complete();
      return;
    }

    // restnoded's setBody serialises objects as JSON and strings as plain text.
    // For HTML/JS/CSS we need to send the raw string with the correct
    // Content-Type. Setting the body as a string works for text files.
    restOperation.setStatusCode(200);
    restOperation.setContentType(mimeType);
    restOperation.setBody(data.toString('utf8'));
    restOperation.complete();
  });
};

module.exports = UiWorker;
