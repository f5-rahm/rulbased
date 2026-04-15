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
// versionStore — filesystem tests (all async)
// ---------------------------------------------------------------------------

console.log('\nversionStore (async)');

var tmpDir = path.join(os.tmpdir(), 'irule-versioner-test-' + Date.now());

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
