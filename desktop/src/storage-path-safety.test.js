// Plain-node test for the Enterprise Storage path-safety helpers (no jest, no
// electron needed): `node src/storage-path-safety.test.js`. Exits non-zero on
// the first failure. These are the security-critical containment checks, so
// they get real, runnable coverage even though the desktop package has no
// jest harness.
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { isSafeSegment, isAbsolutePath, resolveContained } = require('./storage-path-safety');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// isSafeSegment
check('rejects traversal / separators / empties', () => {
  for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'a\0b', 42, null, undefined]) {
    assert.strictEqual(isSafeSegment(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});
check('accepts ordinary folder/customer names', () => {
  for (const good of ['Customers', 'Rudra Suthar', 'Rahul Sharma (abc123)', 'value.txt', 'aadhaar-card.pdf']) {
    assert.strictEqual(isSafeSegment(good), true, `should accept ${good}`);
  }
});

// isAbsolutePath — the exact bug class ("Enterprise testing") must be rejected
check('rejects bare relative names (the original bug)', () => {
  for (const rel of ['Enterprise testing', 'test', './test', '../test', 'DPDP Storage', '']) {
    assert.strictEqual(isAbsolutePath(rel), false, `should reject ${JSON.stringify(rel)}`);
  }
});
check('accepts POSIX / Windows / UNC absolute paths', () => {
  for (const abs of ['/enterprise-storage', 'D:\\DPDP-Storage', 'D:/DPDP-Storage', '\\\\SERVER\\share']) {
    assert.strictEqual(isAbsolutePath(abs), true, `should accept ${abs}`);
  }
});

// resolveContained
const root = path.resolve('/tmp/dpdp-root');
check('contains normal nested segments', () => {
  const target = resolveContained(root, ['Customers', 'Rudra Suthar', 'Customer Information']);
  assert.ok(target === root || target.startsWith(root + path.sep));
  assert.ok(target.endsWith(['Customers', 'Rudra Suthar', 'Customer Information'].join(path.sep)));
});
check('empty segments resolve to the root itself', () => {
  assert.strictEqual(resolveContained(root, []), root);
});
check('throws on a traversal segment', () => {
  assert.throws(() => resolveContained(root, ['Customers', '..', '..', 'Windows']), /PATH_NOT_ALLOWED/);
});
check('throws on a separator-bearing segment', () => {
  assert.throws(() => resolveContained(root, ['a/b']), /PATH_NOT_ALLOWED/);
  assert.throws(() => resolveContained(root, ['a\\b']), /PATH_NOT_ALLOWED/);
});
check('throws on a non-array path', () => {
  assert.throws(() => resolveContained(root, 'Customers'), /PATH_NOT_ALLOWED/);
});

console.log(`\n${passed} checks passed.`);
