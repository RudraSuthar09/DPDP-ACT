// Plain node:assert test (same style as storage-path-safety.test.js).
'use strict';

const assert = require('node:assert/strict');
const { TRUSTED_ORIGIN, isTrustedUrl, isTrustedSender } = require('./trusted-origin');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test('trusted origin is the production app', () => {
  assert.equal(TRUSTED_ORIGIN, 'https://app.hhgoa.work');
});

test('accepts pages on exactly the trusted origin', () => {
  for (const url of [
    'https://app.hhgoa.work',
    'https://app.hhgoa.work/',
    'https://app.hhgoa.work/login?next=%2Fdashboard',
    'https://APP.HHGOA.WORK/data-sources#x',
    'https://app.hhgoa.work:443/consent',
  ]) {
    assert.equal(isTrustedUrl(url), true, url);
  }
});

test('rejects look-alikes, other schemes, ports and hosts', () => {
  for (const url of [
    'https://app.hhgoa.work.attacker.example/',
    'https://app.hhgoa.work@attacker.example/',
    'https://attacker.example/?https://app.hhgoa.work',
    'http://app.hhgoa.work/',
    'https://app.hhgoa.work:8443/',
    'https://api.hhgoa.work/',
    'https://hhgoa.work/',
    'https://evil-app.hhgoa.work/',
    'http://localhost:3000/',
    'file:///C:/Windows/',
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,hi',
    'not a url',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isTrustedUrl(url), false, String(url));
  }
});

test('sender: top-level frame on the trusted origin is accepted', () => {
  assert.equal(isTrustedSender({ senderFrame: { parent: null, url: 'https://app.hhgoa.work/settings' } }), true);
});

test('sender: iframe on the trusted origin is refused', () => {
  const top = { parent: null, url: 'https://app.hhgoa.work/' };
  assert.equal(isTrustedSender({ senderFrame: { parent: top, url: 'https://app.hhgoa.work/embed' } }), false);
});

test('sender: other origins, missing frame or event are refused', () => {
  assert.equal(isTrustedSender({ senderFrame: { parent: null, url: 'https://attacker.example/' } }), false);
  assert.equal(isTrustedSender({ senderFrame: { parent: null, url: 'http://localhost:3000/' } }), false);
  assert.equal(isTrustedSender({ senderFrame: null }), false);
  assert.equal(isTrustedSender({}), false);
  assert.equal(isTrustedSender(undefined), false);
});

console.log(`\n${passed} trusted-origin tests passed`);
