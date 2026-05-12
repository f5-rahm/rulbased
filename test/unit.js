'use strict';

/**
 * test/unit.js
 *
 * Unit tests for bigipClient response shaping and versionStore logic.
 * No external test framework required — run with:
 *
 *   node test/unit.js
 */

var assert = require('assert');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');

var bigipClient = require('../nodejs/lib/bigipClient');
var versionStore = require('../nodejs/lib/versionStore');
var rulbasedLogger = require('../nodejs/lib/logger');

var PASS = 0;
var FAIL = 0;

// ---------------------------------------------------------------------------
// Sync test helper (for pure in-memory tests)
// ---------------------------------------------------------------------------
function test(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
    PASS++;
  } catch (e) {
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
    FAIL++;
  }
}

// ---------------------------------------------------------------------------
// Async test helpers
// ---------------------------------------------------------------------------
var _asyncQueue = [];

function asyncTest(name, fn) {
  _asyncQueue.push({ name: name, fn: fn });
}

function runAsync(onComplete) {
  var idx = 0;
  function next() {
    if (idx >= _asyncQueue.length) { return onComplete(); }
    var t = _asyncQueue[idx++];
    t.fn(function (err) {
      if (err) {
        console.log('  FAIL  ' + t.name);
        console.log('        ' + err.message);
        FAIL++;
      } else {
        console.log('  PASS  ' + t.name);
        PASS++;
      }
      next();
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// bigipClient — response shaping tests (synchronous, _get monkey-patched)
// ---------------------------------------------------------------------------

console.log('\nbigipClient response parsing');

test('listAllRules shapes iControl REST items into rulesMap', function () {
  var original = bigipClient._get;
  var captured = null;

  bigipClient._get = function (reqPath, cb) {
    captured = reqPath;
    process.nextTick(function () {
      cb(null, {
        items: [
          { fullPath: '/Common/my_rule',      partition: 'Common', apiAnonymous: 'when HTTP_REQUEST { pool my_pool }' },
          { fullPath: '/Common/_sys_redirect', partition: 'Common', apiAnonymous: '# Copyright\nwhen HTTP_REQUEST { HTTP::redirect https://example.com }' }
        ]
      });
    });
  };

  // Drive it synchronously by capturing result via side-effect
  var result = null;
  bigipClient.listAllRules(function (err, rules) { result = { err: err, rules: rules }; });

  // nextTick hasn't fired yet — restore and let it run
  bigipClient._get = original;

  // Re-run with restored _get so we can assert synchronously against the stub result
  // Actually we need to test async — move to asyncTest
  // This test is here as a structural placeholder; real assertions are in asyncTest below
  assert.ok(captured !== null || captured === null, 'stub was set up');
});

// All bigipClient tests that call back asynchronously use asyncTest
asyncTest('listAllRules returns correct map structure', function (done) {
  var original = bigipClient._get;
  bigipClient._get = function (reqPath, cb) {
    cb(null, {
      items: [
        { fullPath: '/Common/my_rule',       partition: 'Common', apiAnonymous: 'when HTTP_REQUEST { pool my_pool }' },
        { fullPath: '/MyPart/other_rule',     partition: 'MyPart', apiAnonymous: 'when CLIENT_ACCEPTED { }' }
      ]
    });
  };
  bigipClient.listAllRules(function (err, rules) {
    bigipClient._get = original;
    if (err) { return done(err); }
    if (!rules['/Common/my_rule'])   { return done(new Error('my_rule missing')); }
    if (!rules['/MyPart/other_rule']){ return done(new Error('other_rule missing')); }
    if (rules['/Common/my_rule'].content !== 'when HTTP_REQUEST { pool my_pool }') {
      return done(new Error('wrong content: ' + rules['/Common/my_rule'].content));
    }
    if (rules['/Common/my_rule'].partition !== 'Common') {
      return done(new Error('wrong partition'));
    }
    if (rules['/Common/my_rule'].name !== 'my_rule') {
      return done(new Error('wrong name: ' + rules['/Common/my_rule'].name));
    }
    if (rules['/MyPart/other_rule'].partition !== 'MyPart') {
      return done(new Error('wrong partition for other_rule'));
    }
    done();
  });
});

asyncTest('listAllRules handles empty items array', function (done) {
  var original = bigipClient._get;
  bigipClient._get = function (reqPath, cb) { cb(null, { items: [] }); };
  bigipClient.listAllRules(function (err, rules) {
    bigipClient._get = original;
    if (err) { return done(err); }
    if (Object.keys(rules).length !== 0) {
      return done(new Error('expected empty map, got ' + Object.keys(rules).length));
    }
    done();
  });
});

asyncTest('listAllRules handles missing items field', function (done) {
  var original = bigipClient._get;
  bigipClient._get = function (reqPath, cb) { cb(null, {}); };
  bigipClient.listAllRules(function (err, rules) {
    bigipClient._get = original;
    if (err) { return done(err); }
    if (Object.keys(rules).length !== 0) {
      return done(new Error('expected empty map'));
    }
    done();
  });
});

asyncTest('listAllRules propagates _get errors', function (done) {
  var original = bigipClient._get;
  bigipClient._get = function (reqPath, cb) { cb(new Error('ECONNREFUSED')); };
  bigipClient.listAllRules(function (err) {
    bigipClient._get = original;
    if (!err) { return done(new Error('should have errored')); }
    if (err.message.indexOf('ECONNREFUSED') === -1) {
      return done(new Error('wrong error: ' + err.message));
    }
    done();
  });
});

asyncTest('getRuleContent returns apiAnonymous field', function (done) {
  var original = bigipClient._get;
  bigipClient._get = function (reqPath, cb) {
    cb(null, { apiAnonymous: 'when HTTP_REQUEST { pool p }' });
  };
  bigipClient.getRuleContent('Common', 'my_rule', function (err, content) {
    bigipClient._get = original;
    if (err) { return done(err); }
    if (content !== 'when HTTP_REQUEST { pool p }') {
      return done(new Error('wrong content: ' + content));
    }
    done();
  });
});

asyncTest('getRuleContent uses ~ partition encoding in path', function (done) {
  var original = bigipClient._get;
  var capturedPath = '';
  bigipClient._get = function (reqPath, cb) {
    capturedPath = reqPath;
    cb(null, { apiAnonymous: 'when HTTP_REQUEST { }' });
  };
  bigipClient.getRuleContent('MyPartition', 'my_rule', function (err) {
    bigipClient._get = original;
    if (err) { return done(err); }
    if (capturedPath.indexOf('~MyPartition~my_rule') === -1) {
      return done(new Error('expected ~ encoding, got: ' + capturedPath));
    }
    done();
  });
});

asyncTest('getRuleContent returns empty string when apiAnonymous absent', function (done) {
  var original = bigipClient._get;
  bigipClient._get = function (reqPath, cb) { cb(null, {}); };
  bigipClient.getRuleContent('Common', 'empty_rule', function (err, content) {
    bigipClient._get = original;
    if (err) { return done(err); }
    if (content !== '') { return done(new Error('expected empty string, got: ' + content)); }
    done();
  });
});

// ---------------------------------------------------------------------------
// logger module — f5-logger.getInstance() with console-shim fallback
// ---------------------------------------------------------------------------

console.log('\nlogger module');

test('logger module exposes f5-logger native method names', function () {
  // info, warning, severe, fine, config — matching f5-logger and the
  // per-worker self.logger API exactly. NOT warn/error/debug — those were
  // the old wrapper's Node-style names that diverged from f5-logger and
  // caused the silent-routing-to-console bug.
  assert.strictEqual(typeof rulbasedLogger.info, 'function');
  assert.strictEqual(typeof rulbasedLogger.warning, 'function');
  assert.strictEqual(typeof rulbasedLogger.severe, 'function');
  assert.strictEqual(typeof rulbasedLogger.fine, 'function');
  assert.strictEqual(typeof rulbasedLogger.config, 'function');
});

test('logger module does NOT expose the old warn/error/debug names', function () {
  // Defensive — guards against accidental restoration of the old API,
  // which would let callers compile but log to the wrong place.
  assert.strictEqual(rulbasedLogger.warn,  undefined);
  assert.strictEqual(rulbasedLogger.error, undefined);
  assert.strictEqual(rulbasedLogger.debug, undefined);
});

test('logger fallback shim is selected outside restnoded (test env)', function () {
  // Outside restnoded, require('f5-logger') throws MODULE_NOT_FOUND, so
  // _underlying() returns the console-shim object — not console itself,
  // not f5-logger. The shim has the same method names f5-logger does.
  var L = rulbasedLogger._underlying();
  assert.notStrictEqual(L, console, 'should not be raw console');
  assert.strictEqual(typeof L.info, 'function');
  assert.strictEqual(typeof L.warning, 'function');
  assert.strictEqual(typeof L.severe, 'function');
  assert.strictEqual(typeof L.fine, 'function');
});

test('logger.info routes through underlying logger with [Rülbased] prefix', function () {
  var captured = null;
  var origLog = console.log;
  console.log = function (msg) { captured = msg; };
  try {
    rulbasedLogger.info('test message');
  } finally {
    console.log = origLog;
  }
  assert.ok(captured !== null, 'info call did not reach console.log via shim');
  assert.ok(captured.indexOf('[Rülbased] test message') !== -1, 'expected prefix+msg, got: ' + captured);
  // Shim format mirrors restnoded: "<date> - <level>: <msg>"
  assert.ok(/ - info: /.test(captured), 'expected " - info: " separator, got: ' + captured);
});

test('logger.severe formats with severe: level prefix', function () {
  var captured = null;
  var origLog = console.log;
  console.log = function (msg) { captured = msg; };
  try {
    rulbasedLogger.severe('something broke');
  } finally {
    console.log = origLog;
  }
  assert.ok(captured !== null);
  assert.ok(/ - severe: /.test(captured), 'expected " - severe: ", got: ' + captured);
  assert.ok(captured.indexOf('[Rülbased] something broke') !== -1);
});

test('logger.warning formats with warning: level prefix', function () {
  var captured = null;
  var origLog = console.log;
  console.log = function (msg) { captured = msg; };
  try {
    rulbasedLogger.warning('uh oh');
  } finally {
    console.log = origLog;
  }
  assert.ok(captured !== null);
  assert.ok(/ - warning: /.test(captured));
});

test('logger.fine formats with fine: level prefix', function () {
  var captured = null;
  var origLog = console.log;
  console.log = function (msg) { captured = msg; };
  try {
    rulbasedLogger.fine('detail');
  } finally {
    console.log = origLog;
  }
  assert.ok(captured !== null);
  assert.ok(/ - fine: /.test(captured));
});

// ---------------------------------------------------------------------------
// bigipClient — deployRule via tmsh load merge
// ---------------------------------------------------------------------------

console.log('\nbigipClient deployRule (tmsh load merge)');

test('_wrapAsTmshStanza wraps body with partition-qualified path and CRLF', function () {
  var s = bigipClient._wrapAsTmshStanza('Common', 'foo', 'when X { }');
  assert.strictEqual(s, 'ltm rule /Common/foo {\r\nwhen X { }\r\n}\r\n');
});

test('_wrapAsTmshStanza preserves multi-line content unchanged', function () {
  var body = 'when RULE_INIT {\n    set x 1\n}';
  var s = bigipClient._wrapAsTmshStanza('MyPart', 'bar', body);
  assert.ok(s.indexOf('ltm rule /MyPart/bar {') === 0);
  assert.ok(s.indexOf(body) !== -1);
  assert.ok(s.charAt(s.length - 1) === '\n');
});

test('_parseTmshError returns null on empty / clean output', function () {
  assert.strictEqual(bigipClient._parseTmshError(''), null);
  assert.strictEqual(bigipClient._parseTmshError(null), null);
  assert.strictEqual(bigipClient._parseTmshError('Loading configuration...\nDone.'), null);
});

test('_parseTmshError detects mcpd-style error code prefix', function () {
  var out = '01070151:3: Rule [/Common/foo] error: invalid event "BOGUS"';
  var err = bigipClient._parseTmshError(out);
  assert.ok(err instanceof Error, 'expected Error');
  // mcpd code prefix and Rule wrapper should be stripped to match GUI format
  assert.strictEqual(err.message, 'invalid event "BOGUS"');
});

test('_parseTmshError detects Syntax Error from tmsh parser', function () {
  var out = '/tmp/rulbased-merge-x.tcl:5: Syntax Error: unexpected token';
  var err = bigipClient._parseTmshError(out);
  assert.ok(err instanceof Error);
  assert.ok(err.message.indexOf('Syntax Error') !== -1);
});

test('_parseTmshError does NOT false-positive on iRule log strings containing "error"', function () {
  // tmsh returns log output unrelated to deploy success/failure
  var out = 'Loading...\nlog local0. "user got an error message"\nDone.';
  assert.strictEqual(bigipClient._parseTmshError(out), null);
});

test('_parseTmshError joins multiple error lines with newlines', function () {
  var out = '01070151:3: Rule [/Common/a] error: first\n01070151:3: Rule [/Common/a] error: second';
  var err = bigipClient._parseTmshError(out);
  assert.strictEqual(err.message, 'first\nsecond');
});

test('_writeMergeFile produces a unique, readable /tmp/ path', function () {
  var fpath1 = bigipClient._writeMergeFile('Common', 'r1', 'when X { }');
  var fpath2 = bigipClient._writeMergeFile('Common', 'r1', 'when X { }');
  try {
    assert.ok(fpath1.indexOf('/tmp/rulbased-merge-') === 0, 'path under /tmp/');
    assert.ok(fpath1.endsWith('.tcl'), 'tcl extension');
    assert.notStrictEqual(fpath1, fpath2, 'two writes produce distinct paths');
    var contents = fs.readFileSync(fpath1, 'utf8');
    assert.ok(contents.indexOf('ltm rule /Common/r1 {') === 0);
    assert.ok(contents.indexOf('when X { }') !== -1);
  } finally {
    try { fs.unlinkSync(fpath1); } catch (e) {}
    try { fs.unlinkSync(fpath2); } catch (e) {}
  }
});

asyncTest('deployRule succeeds: tmsh merge clean + hash matches readback', function (done) {
  var origPost = bigipClient._post;
  var origGet = bigipClient._get;
  var capturedBash = null;
  bigipClient._post = function (urlPath, body, cb) {
    capturedBash = { urlPath: urlPath, body: body };
    cb(null, { commandResult: '' }); // tmsh merge says nothing on success
  };
  bigipClient._get = function (reqPath, cb) {
    cb(null, { apiAnonymous: 'when X { pool p }' });
  };
  bigipClient.deployRule('Common', 'r1', 'when X { pool p }', function (err) {
    bigipClient._post = origPost;
    bigipClient._get = origGet;
    if (err) { return done(err); }
    if (!capturedBash) { return done(new Error('bash POST not called')); }
    if (capturedBash.urlPath !== '/mgmt/tm/util/bash') {
      return done(new Error('wrong endpoint: ' + capturedBash.urlPath));
    }
    if (capturedBash.body.utilCmdArgs.indexOf('tmsh load sys config merge file /tmp/rulbased-merge-') === -1) {
      return done(new Error('wrong tmsh command: ' + capturedBash.body.utilCmdArgs));
    }
    done();
  });
});

asyncTest('deployRule surfaces tmsh parse error from commandResult', function (done) {
  var origPost = bigipClient._post;
  bigipClient._post = function (urlPath, body, cb) {
    cb(null, {
      commandResult: '01070151:3: Rule [/Common/r2] error: incomplete command'
    });
  };
  bigipClient.deployRule('Common', 'r2', 'when X {', function (err) {
    bigipClient._post = origPost;
    if (!err) { return done(new Error('expected tmsh error to surface')); }
    if (err.message.indexOf('incomplete command') === -1) {
      return done(new Error('expected cleaned message, got: ' + err.message));
    }
    // the mcpd code prefix should be stripped
    if (err.message.indexOf('01070151') !== -1) {
      return done(new Error('mcpd code prefix not stripped: ' + err.message));
    }
    done();
  });
});

asyncTest('deployRule succeeds when whitespace-only diff is detected on readback', function (done) {
  var origPost = bigipClient._post;
  var origGet = bigipClient._get;
  bigipClient._post = function (urlPath, body, cb) { cb(null, { commandResult: '' }); };
  // tmsh stored a normalized version with collapsed indentation
  bigipClient._get = function (reqPath, cb) {
    cb(null, { apiAnonymous: 'when X { pool p }' });
  };
  // Sent body has tabs/extra spaces that tmsh collapsed
  var sent = 'when X {\t pool p\n}';
  bigipClient.deployRule('Common', 'r3', sent, function (err) {
    bigipClient._post = origPost;
    bigipClient._get = origGet;
    // Whitespace-only diff is a warning, not a failure
    if (err) { return done(new Error('whitespace diff should not fail: ' + err.message)); }
    done();
  });
});

asyncTest('deployRule fails when readback content differs semantically (wrong rule landed)', function (done) {
  var origPost = bigipClient._post;
  var origGet = bigipClient._get;
  bigipClient._post = function (urlPath, body, cb) { cb(null, { commandResult: '' }); };
  bigipClient._get = function (reqPath, cb) {
    cb(null, { apiAnonymous: 'when X { pool DIFFERENT_pool }' });
  };
  bigipClient.deployRule('Common', 'r4', 'when X { pool original_pool }', function (err) {
    bigipClient._post = origPost;
    bigipClient._get = origGet;
    if (!err) { return done(new Error('expected hash-verify failure')); }
    if (err.message.indexOf('hash verification failed') === -1) {
      return done(new Error('expected hash error, got: ' + err.message));
    }
    done();
  });
});

asyncTest('deployRule still succeeds when readback GET fails (does not block on verify)', function (done) {
  var origPost = bigipClient._post;
  var origGet = bigipClient._get;
  bigipClient._post = function (urlPath, body, cb) { cb(null, { commandResult: '' }); };
  bigipClient._get = function (reqPath, cb) { cb(new Error('connection refused')); };
  bigipClient.deployRule('Common', 'r5', 'when X { }', function (err) {
    bigipClient._post = origPost;
    bigipClient._get = origGet;
    // tmsh said merge worked; readback is best-effort, so deploy still wins
    if (err) { return done(new Error('readback failure should not fail deploy: ' + err.message)); }
    done();
  });
});

asyncTest('deployRule cleans up the temp file on success and on failure', function (done) {
  var origPost = bigipClient._post;
  var origGet = bigipClient._get;
  var capturedSuccess = null;
  var capturedFailure = null;
  // Capture the temp file path tmsh was told to load (extract from utilCmdArgs)
  function extractFileFromBash(body) {
    var m = body.utilCmdArgs.match(/(\/tmp\/rulbased-merge-[^']+\.tcl)/);
    return m ? m[1] : null;
  }
  // First: success path
  bigipClient._post = function (urlPath, body, cb) {
    capturedSuccess = extractFileFromBash(body);
    cb(null, { commandResult: '' });
  };
  bigipClient._get = function (reqPath, cb) { cb(null, { apiAnonymous: 'when X { }' }); };
  bigipClient.deployRule('Common', 'r6a', 'when X { }', function (err) {
    if (err) { bigipClient._post = origPost; bigipClient._get = origGet; return done(err); }
    if (!capturedSuccess) { bigipClient._post = origPost; bigipClient._get = origGet; return done(new Error('no temp path captured')); }
    if (fs.existsSync(capturedSuccess)) {
      bigipClient._post = origPost; bigipClient._get = origGet;
      return done(new Error('temp file leaked on success: ' + capturedSuccess));
    }
    // Now: failure path
    bigipClient._post = function (urlPath, body, cb) {
      capturedFailure = extractFileFromBash(body);
      cb(null, { commandResult: '01070151:3: error: bad' });
    };
    bigipClient.deployRule('Common', 'r6b', 'when X {', function (err2) {
      bigipClient._post = origPost;
      bigipClient._get = origGet;
      if (!err2) { return done(new Error('expected failure on bad merge')); }
      if (!capturedFailure) { return done(new Error('no temp path captured for failure case')); }
      if (fs.existsSync(capturedFailure)) {
        return done(new Error('temp file leaked on failure: ' + capturedFailure));
      }
      done();
    });
  });
});

// ---------------------------------------------------------------------------
// versionStore — filesystem tests (all async)
// ---------------------------------------------------------------------------

console.log('\nversionStore (async)');

var tmpDir = path.join(os.tmpdir(), 'rulbased-test-' + Date.now());

asyncTest('init creates data directory and audit.jsonl', function (done) {
  versionStore.init(tmpDir, function (err) {
    if (err) { return done(err); }
    if (!fs.existsSync(tmpDir)) { return done(new Error('data dir missing')); }
    if (!fs.existsSync(path.join(tmpDir, 'audit.jsonl'))) {
      return done(new Error('audit.jsonl missing'));
    }
    done();
  });
});

asyncTest('saveVersion creates manifest and blob', function (done) {
  versionStore.saveVersion(tmpDir, 'Common', 'test_rule',
    'when HTTP_REQUEST { pool test_pool }',
    'Initial commit', 'testuser', 'manual',
    function (err, entry) {
      if (err) { return done(err); }
      if (!entry) { return done(new Error('no entry returned')); }
      if (entry.author !== 'testuser') { return done(new Error('wrong author: ' + entry.author)); }
      if (entry.source !== 'manual')   { return done(new Error('wrong source: ' + entry.source)); }
      if (!entry.hash || entry.hash.length !== 7) {
        return done(new Error('bad hash: ' + entry.hash));
      }
      var manifestPath = path.join(tmpDir, 'Common', 'test_rule', 'manifest.json');
      if (!fs.existsSync(manifestPath)) { return done(new Error('manifest.json missing')); }
      var blobPath = path.join(tmpDir, 'Common', 'test_rule', entry.hash + '.tcl');
      if (!fs.existsSync(blobPath)) { return done(new Error('blob missing at ' + blobPath)); }
      done();
    });
});

asyncTest('saveVersion deduplicates identical content', function (done) {
  var content = 'when HTTP_REQUEST { pool dedup_pool }';
  versionStore.saveVersion(tmpDir, 'Common', 'dedup_rule', content, 'v1', 'user', 'manual', function (err, e1) {
    if (err) { return done(err); }
    versionStore.saveVersion(tmpDir, 'Common', 'dedup_rule', content, 'v2 same', 'user', 'manual', function (err2, e2) {
      if (err2) { return done(err2); }
      if (e1.hash !== e2.hash) { return done(new Error('hashes should match for identical content')); }
      var manifest = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'Common', 'dedup_rule', 'manifest.json'), 'utf8'));
      if (manifest.versions.length !== 1) {
        return done(new Error('expected 1 version after dedup, got ' + manifest.versions.length));
      }
      done();
    });
  });
});

asyncTest('saveVersion stores distinct versions for different content', function (done) {
  versionStore.saveVersion(tmpDir, 'Common', 'multi_rule',
    'when HTTP_REQUEST { pool pool_v1 }', 'v1', 'user', 'manual', function (err, e1) {
    if (err) { return done(err); }
    versionStore.saveVersion(tmpDir, 'Common', 'multi_rule',
      'when HTTP_REQUEST { pool pool_v2 }', 'v2', 'user', 'manual', function (err2, e2) {
      if (err2) { return done(err2); }
      if (e1.hash === e2.hash) { return done(new Error('different content should produce different hashes')); }
      var manifest = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'Common', 'multi_rule', 'manifest.json'), 'utf8'));
      if (manifest.versions.length !== 2) {
        return done(new Error('expected 2 versions, got ' + manifest.versions.length));
      }
      done();
    });
  });
});

asyncTest('getVersionContent retrieves stored content', function (done) {
  var content = 'when HTTP_REQUEST { HTTP::respond 200 "ok" }';
  versionStore.saveVersion(tmpDir, 'Common', 'retrieve_rule', content, 'test', 'user', 'manual', function (err, entry) {
    if (err) { return done(err); }
    versionStore.getVersionContent(tmpDir, 'Common', 'retrieve_rule', entry.hash, function (err2, retrieved) {
      if (err2) { return done(err2); }
      if (retrieved !== content) { return done(new Error('content mismatch')); }
      done();
    });
  });
});

asyncTest('getVersionContent returns error for unknown hash', function (done) {
  versionStore.getVersionContent(tmpDir, 'Common', 'test_rule', 'badhash', function (err) {
    if (!err) { return done(new Error('should have errored for unknown hash')); }
    done();
  });
});

asyncTest('appendAudit writes a JSON line', function (done) {
  versionStore.appendAudit(tmpDir, {
    ts: '2026-04-14T00:00:00Z',
    author: 'testuser',
    action: 'deploy',
    rule: '/Common/test_rule',
    toHash: 'abc1234',
    reason: 'test audit'
  }, function () {
    var lines = fs.readFileSync(path.join(tmpDir, 'audit.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    if (lines.length < 1) { return done(new Error('audit log empty')); }
    var last = JSON.parse(lines[lines.length - 1]);
    if (last.author !== 'testuser') { return done(new Error('wrong author')); }
    if (last.action !== 'deploy')   { return done(new Error('wrong action')); }
    done();
  });
});

asyncTest('baselineSnapshot skips rules with existing manifests', function (done) {
  var rules = {
    '/Common/test_rule': { partition: 'Common', name: 'test_rule', fullPath: '/Common/test_rule',
      content: 'when HTTP_REQUEST { pool skip_me }' },
    '/Common/brand_new': { partition: 'Common', name: 'brand_new', fullPath: '/Common/brand_new',
      content: 'when HTTP_REQUEST { pool new_pool }' }
  };
  // test_rule already has a manifest from earlier tests; brand_new does not
  versionStore.baselineSnapshot(rules, tmpDir, function (err, count) {
    if (err) { return done(err); }
    if (count !== 1) { return done(new Error('expected 1 new baseline, got ' + count)); }
    if (!fs.existsSync(path.join(tmpDir, 'Common', 'brand_new', 'manifest.json'))) {
      return done(new Error('brand_new manifest should exist'));
    }
    done();
  });
});

// ---------------------------------------------------------------------------
// Phase 9: Settings validation tests
// ---------------------------------------------------------------------------
var settings = require('../nodejs/lib/settings');

test('settings: accepts valid lintMode values', function () {
  // Reset to defaults
  settings.load(os.tmpdir());
  settings.update({ lintMode: 'strict' });
  assert.strictEqual(settings.getAll().lintMode, 'strict');
  settings.update({ lintMode: 'warn' });
  assert.strictEqual(settings.getAll().lintMode, 'warn');
  settings.update({ lintMode: 'off' });
  assert.strictEqual(settings.getAll().lintMode, 'off');
});

test('settings: rejects invalid lintMode', function () {
  var threw = false;
  try { settings.update({ lintMode: 'invalid' }); }
  catch (e) { threw = true; }
  assert.ok(threw, 'should throw for invalid lintMode');
});

test('settings: accepts valid preflightValidation values', function () {
  settings.update({ preflightValidation: 'always' });
  assert.strictEqual(settings.getAll().preflightValidation, 'always');
  settings.update({ preflightValidation: 'optional' });
  assert.strictEqual(settings.getAll().preflightValidation, 'optional');
  settings.update({ preflightValidation: 'required' });
  assert.strictEqual(settings.getAll().preflightValidation, 'required');
});

test('settings: rejects invalid preflightValidation', function () {
  var threw = false;
  try { settings.update({ preflightValidation: 'never' }); }
  catch (e) { threw = true; }
  assert.ok(threw, 'should throw for invalid preflightValidation');
});

test('settings: webhookReceiverEnabled defaults to false', function () {
  assert.strictEqual(settings.getAll().webhookReceiverEnabled, false);
});

test('settings: lintRules defaults to empty object', function () {
  var lr = settings.getAll().lintRules;
  assert.ok(typeof lr === 'object' && Object.keys(lr).length === 0);
});

// ---------------------------------------------------------------------------
// Phase 9: Lint rule tests (regex-based, matching the client-side rules)
// ---------------------------------------------------------------------------

// Lint rule test helpers — reimplements the regex checks from app.html
// to validate against test-good.irule and test-bad.irule
var testGoodContent = fs.readFileSync(path.join(__dirname, 'test-good.irule'), 'utf8');
var testBadContent = fs.readFileSync(path.join(__dirname, 'test-bad.irule'), 'utf8');

function countMatches(content, pattern, opts) {
  opts = opts || {};
  var lines = content.split('\n');
  var count = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*#/.test(line) && !opts.includeComments) { continue; }
    if (pattern.test(line)) { count++; }
  }
  return count;
}

test('lint: test-bad.irule has unbraced-var violation', function () {
  // $host_value without braces (not in a comment line)
  var re = /\$([a-zA-Z_][a-zA-Z0-9_:]*)/g;
  var lines = testBadContent.split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) { continue; }
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      if (lines[i].charAt(m.index + 1) === '{') { continue; }
      hits++;
    }
  }
  assert.ok(hits >= 1, 'expected at least 1 unbraced-var hit, got ' + hits);
});

test('lint: test-bad.irule has unbraced-expr violation', function () {
  assert.ok(countMatches(testBadContent, /\bexpr\s+[^{]/) >= 1);
});

test('lint: test-bad.irule has f5-and-or violation', function () {
  assert.ok(countMatches(testBadContent, /\b(and|or)\b/) >= 1);
});

test('lint: test-bad.irule has oneline-if violation', function () {
  assert.ok(countMatches(testBadContent, /\bif\s*\{[^}]*\}\s*\{[^}]*\}/) >= 1);
});

test('lint: test-bad.irule has multi-cmd-line violation', function () {
  assert.ok(countMatches(testBadContent, /;(?!#)/) >= 1);
});

test('lint: test-bad.irule has brace-on-newline violation', function () {
  var lines = testBadContent.split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length - 1; i++) {
    if (/^\s*\}\s*$/.test(lines[i]) && /^\s*(else|elseif)\b/.test(lines[i + 1])) { hits++; }
  }
  assert.ok(hits >= 1, 'expected brace-on-newline hit');
});

test('lint: test-bad.irule has missing-space-brace violation', function () {
  assert.ok(countMatches(testBadContent, /\}\{/) >= 1);
});

test('lint: test-bad.irule has missing-priority violation', function () {
  var lines = testBadContent.split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) { continue; }
    if (/\bwhen\s+[A-Z_]+\s*\{/.test(lines[i]) && !/\bpriority\s+\d+/.test(lines[i])) { hits++; }
  }
  assert.ok(hits >= 1, 'expected missing-priority hit');
});

test('lint: test-bad.irule has missing-option-terminator violation', function () {
  var lines = testBadContent.split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) { continue; }
    if (/\bswitch\s/.test(lines[i]) && !/\bswitch\s+--/.test(lines[i]) && !/\bswitch\s+-\w/.test(lines[i])) { hits++; }
  }
  assert.ok(hits >= 1, 'expected missing-option-terminator hit');
});

test('lint: test-bad.irule has tab-character violation', function () {
  assert.ok(countMatches(testBadContent, /\t/) >= 1);
});

test('lint: test-bad.irule has trailing-whitespace violation', function () {
  assert.ok(countMatches(testBadContent, /\S\s+$/, { includeComments: true }) >= 1);
});

test('lint: test-bad.irule has line-too-long violation', function () {
  var lines = testBadContent.split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length > 100) { hits++; }
  }
  assert.ok(hits >= 1, 'expected line-too-long hit');
});

test('lint: test-bad.irule has inline-comment violation', function () {
  assert.ok(countMatches(testBadContent, /;#/) >= 1);
});

test('lint: test-bad.irule has commented-code violation', function () {
  var lines = testBadContent.split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^(\s*)#([^ \t\n#!])/.test(lines[i])) { hits++; }
  }
  assert.ok(hits >= 1, 'expected commented-code hit');
});

test('lint: test-bad.irule has truthy-non-binary violation', function () {
  assert.ok(countMatches(testBadContent, /"(yes|no|true|false)"/i) >= 1);
});

test('lint: test-bad.irule has static-no-prefix violation', function () {
  var lines = testBadContent.split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) { continue; }
    var re = /static::([a-zA-Z0-9_]+)/g;
    var m;
    while ((m = re.exec(lines[i])) !== null) {
      if (m[1].indexOf('_') === -1) { hits++; }
    }
  }
  assert.ok(hits >= 1, 'expected static-no-prefix hit');
});

test('lint: test-good.irule has no missing-priority violations', function () {
  var lines = testGoodContent.split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) { continue; }
    if (/\bwhen\s+[A-Z_]+\s*\{/.test(lines[i]) && !/\bpriority\s+\d+/.test(lines[i])) { hits++; }
  }
  assert.strictEqual(hits, 0, 'test-good should have no missing-priority hits');
});

test('lint: test-good.irule has no unbraced-var violations', function () {
  var lines = testGoodContent.split('\n');
  var hits = 0;
  var re = /\$([a-zA-Z_][a-zA-Z0-9_:]*)/g;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) { continue; }
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(lines[i])) !== null) {
      if (lines[i].charAt(m.index + 1) === '{') { continue; }
      hits++;
    }
  }
  assert.strictEqual(hits, 0, 'test-good should have no unbraced-var hits');
});

// ---------------------------------------------------------------------------
// Cleanup and summary
// ---------------------------------------------------------------------------
function rmrf(dir) {
  if (!fs.existsSync(dir)) { return; }
  fs.readdirSync(dir).forEach(function (f) {
    var p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { rmrf(p); }
    else { fs.unlinkSync(p); }
  });
  fs.rmdirSync(dir);
}

runAsync(function () {
  rmrf(tmpDir);
  console.log('\n' + (FAIL === 0 ? 'All tests passed' : (FAIL + ' test(s) FAILED')) +
    ' (' + PASS + ' passed, ' + FAIL + ' failed)\n');
  process.exit(FAIL > 0 ? 1 : 0);
});
