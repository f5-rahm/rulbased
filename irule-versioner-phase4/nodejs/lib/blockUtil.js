'use strict';

/**
 * blockUtil.js
 *
 * Helpers for reading iApps LX block input properties and setting
 * block state in REST operation responses.
 *
 * iApps LX inputProperties is an array like:
 *   [{ "id": "pollIntervalSeconds", "value": 300 }, ...]
 *
 * These helpers flatten it into a plain object and handle the state
 * transitions the framework expects.
 */

/**
 * Extract inputProperties array into a plain key→value object.
 */
function getInputProperties(body) {
  var result = {};
  if (!body || !Array.isArray(body.inputProperties)) { return result; }
  body.inputProperties.forEach(function (prop) {
    if (prop && prop.id !== undefined) {
      result[prop.id] = prop.value !== undefined ? prop.value : prop.defaultValue;
    }
  });
  return result;
}

/**
 * Transition the block to BOUND state with optional output properties.
 */
function setBound(restOperation, outputProperties) {
  var body = restOperation.getBody();
  body.state = 'BOUND';
  body.presentationHtmlReference = body.presentationHtmlReference || {};
  if (outputProperties && outputProperties.length) {
    body.outputProperties = outputProperties.map(function (p) {
      return { id: p.id, value: p.value };
    });
  }
  restOperation.setStatusCode(200);
  restOperation.setBody(body);
  restOperation.complete();
}

/**
 * Transition the block to UNBOUND state.
 */
function setUnbound(restOperation) {
  var body = restOperation.getBody();
  body.state = 'UNBOUND';
  restOperation.setStatusCode(200);
  restOperation.setBody(body);
  restOperation.complete();
}

/**
 * Transition the block to ERROR state with a message.
 */
function setError(restOperation, message) {
  var body = restOperation.getBody();
  body.state = 'ERROR';
  body.error = message;
  restOperation.setStatusCode(400);
  restOperation.setBody(body);
  restOperation.complete();
}

module.exports = { getInputProperties: getInputProperties, setBound: setBound, setUnbound: setUnbound, setError: setError };
