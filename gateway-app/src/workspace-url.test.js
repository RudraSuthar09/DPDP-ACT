// Plain-node test (no jest, no electron needed): `node src/workspace-url.test.js`.
'use strict';

const assert = require('node:assert');
const { validateWorkspaceUrl } = require('./workspace-url');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

check('accepts a valid HTTPS workspace URL', () => {
  const r = validateWorkspaceUrl('https://acme.dpdp.example.com');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, 'https://acme.dpdp.example.com');
});

check('strips a trailing path/query/fragment down to the origin', () => {
  const r = validateWorkspaceUrl('https://acme.dpdp.example.com/some/path?x=1#y');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, 'https://acme.dpdp.example.com');
});

check('rejects an empty string', () => {
  assert.strictEqual(validateWorkspaceUrl('').ok, false);
  assert.strictEqual(validateWorkspaceUrl('   ').ok, false);
});

check('rejects garbage that is not a URL at all', () => {
  assert.strictEqual(validateWorkspaceUrl('not a url').ok, false);
});

check('rejects a non-http(s) scheme', () => {
  assert.strictEqual(validateWorkspaceUrl('ftp://example.com').ok, false);
  assert.strictEqual(validateWorkspaceUrl('javascript:alert(1)').ok, false);
  assert.strictEqual(validateWorkspaceUrl('file:///etc/passwd').ok, false);
});

check('rejects plain HTTP for a non-loopback host (the core security rule)', () => {
  const r = validateWorkspaceUrl('http://acme.dpdp.example.com');
  assert.strictEqual(r.ok, false);
  assert.ok(/https/i.test(r.reason));
});

check('allows plain HTTP only for localhost/127.0.0.1/::1 (local dev/test)', () => {
  assert.strictEqual(validateWorkspaceUrl('http://localhost:3001').ok, true);
  assert.strictEqual(validateWorkspaceUrl('http://127.0.0.1:3001').ok, true);
  assert.strictEqual(validateWorkspaceUrl('http://[::1]:3001').ok, true);
});

check('accepts HTTPS for a loopback host too (not forced to http)', () => {
  assert.strictEqual(validateWorkspaceUrl('https://localhost:3001').ok, true);
});

check('is case-insensitive about the loopback hostname', () => {
  assert.strictEqual(validateWorkspaceUrl('http://LOCALHOST:3001').ok, true);
});

console.log(`\n${passed} passed`);
