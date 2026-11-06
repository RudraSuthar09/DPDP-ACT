// Plain-node test: `node src/request-file.test.js`.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REQUEST_FILE_PATTERN } = require('./elevated-command');
const { consumeResult, createRequestFile, scrubAndDelete, validatePairPayload, validateSourcePayload } = require('./request-file');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdp-reqfile-'));
const CODE = 'Abc123_-xyzXYZ0987654321abcdefghijklmnopqrs';

try {
  check('creates a uniquely named request file the helper will accept, holding exactly the payload', () => {
    const a = createRequestFile({ x: 1 }, dir);
    const b = createRequestFile({ x: 2 }, dir);
    assert.notStrictEqual(a.requestPath, b.requestPath);
    assert.ok(REQUEST_FILE_PATTERN.test(path.basename(a.requestPath)));
    assert.strictEqual(path.basename(a.resultPath).replace('result', 'request'), path.basename(a.requestPath));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(a.requestPath, 'utf8')), { x: 1 });
  });

  check('scrubAndDelete removes the request file, and tolerates it already being gone', () => {
    const { requestPath } = createRequestFile({ password: 'p' }, dir);
    scrubAndDelete(requestPath);
    assert.ok(!fs.existsSync(requestPath));
    scrubAndDelete(requestPath);
  });

  check('consumeResult reads the helper outcome (incl. a UTF-8 BOM) and deletes it; null when absent', () => {
    const resultPath = path.join(dir, 'dpdp-gw-result-0123456789abcdef0123456789abcdef.json');
    fs.writeFileSync(resultPath, '\uFEFF{"ok":false,"error":"The enrolment code was rejected."}');
    assert.deepStrictEqual(consumeResult(resultPath), { ok: false, error: 'The enrolment code was rejected.' });
    assert.ok(!fs.existsSync(resultPath));
    assert.strictEqual(consumeResult(resultPath), null);
  });

  check('pair payload: valid input is normalized to the workspace origin', () => {
    assert.deepStrictEqual(validatePairPayload({ enrollmentCode: ` ${CODE} `, controlPlaneUrl: 'https://acme.example.com/x', displayName: ' PC ' }), {
      ok: true,
      payload: { enrollmentCode: CODE, controlPlaneUrl: 'https://acme.example.com', displayName: 'PC' },
    });
  });

  check('pair payload: rejects malformed codes and non-HTTPS production URLs', () => {
    assert.strictEqual(validatePairPayload({ enrollmentCode: "x'; calc", controlPlaneUrl: 'https://a.example' }).ok, false);
    assert.strictEqual(validatePairPayload({ enrollmentCode: CODE, controlPlaneUrl: 'http://a.example' }).ok, false);
    assert.strictEqual(validatePairPayload(null).ok, false);
  });

  check('source payload: a database source keeps exactly the expected fields', () => {
    const r = validateSourcePayload({
      sourceId: 'crm',
      kind: 'postgresql',
      connection: { host: ' db ', port: '5432', user: 'ro', password: 'pw', database: 'crm', extra: 'dropped' },
      evil: 'dropped',
    });
    assert.deepStrictEqual(r, { ok: true, payload: { sourceId: 'crm', kind: 'postgresql', connection: { host: 'db', port: 5432, user: 'ro', password: 'pw', database: 'crm' } } });
  });

  check('source payload: only implemented connector kinds are accepted', () => {
    for (const kind of ['oracle', 'mongodb', 'sap', '', undefined]) {
      assert.strictEqual(validateSourcePayload({ sourceId: 'x', kind }).ok, false);
    }
  });

  check('source payload: folder sources need an absolute local or UNC path', () => {
    assert.strictEqual(validateSourcePayload({ sourceId: 'f', kind: 'csv', root: 'D:\\Exports' }).ok, true);
    assert.strictEqual(validateSourcePayload({ sourceId: 'f', kind: 'csv', root: '\\\\srv\\share\\x' }).ok, true);
    assert.strictEqual(validateSourcePayload({ sourceId: 'f', kind: 'csv', root: 'Exports' }).ok, false);
    assert.strictEqual(validateSourcePayload({ sourceId: 'f', kind: 'csv', root: '..\\..\\Windows' }).ok, false);
  });

  check('source payload: a folder with no permission choice is read-only, with exactly its old payload', () => {
    assert.deepStrictEqual(validateSourcePayload({ sourceId: 'f', kind: 'filesystem', root: 'D:\\x' }), {
      ok: true,
      payload: { sourceId: 'f', kind: 'filesystem', roots: ['D:\\x'] },
    });
    assert.deepStrictEqual(validateSourcePayload({ sourceId: 'f', kind: 'filesystem', root: 'D:\\x', access: 'read', storageRootId: 'ignored' }), {
      ok: true,
      payload: { sourceId: 'f', kind: 'filesystem', roots: ['D:\\x'] },
    });
  });

  check('source payload: write and both carry the storage location ID; write-only is keyed by it', () => {
    const SR = '0b6a6b9e-1d3c-4a71-9c6f-1f0e0d0c0b0a';
    assert.deepStrictEqual(validateSourcePayload({ sourceId: '', kind: 'filesystem', root: 'D:\\Out', access: 'write', storageRootId: SR }), {
      ok: true,
      payload: { sourceId: SR, kind: 'filesystem', roots: ['D:\\Out'], access: 'write', storageRootId: SR },
    });
    assert.deepStrictEqual(validateSourcePayload({ sourceId: 'ds1', kind: 'filesystem', root: 'D:\\Out', access: 'both', storageRootId: SR }), {
      ok: true,
      payload: { sourceId: 'ds1', kind: 'filesystem', roots: ['D:\\Out'], access: 'both', storageRootId: SR },
    });
  });

  check('source payload: write permission is refused for databases, unknown values, or without a storage location ID', () => {
    const SR = '0b6a6b9e-1d3c-4a71-9c6f-1f0e0d0c0b0a';
    assert.strictEqual(validateSourcePayload({ sourceId: 'x', kind: 'postgresql', access: 'write', storageRootId: SR, connection: { host: 'h', port: 1, user: 'u', database: 'd' } }).ok, false);
    assert.strictEqual(validateSourcePayload({ sourceId: 'x', kind: 'filesystem', root: 'D:\\x', access: 'admin', storageRootId: SR }).ok, false);
    assert.strictEqual(validateSourcePayload({ sourceId: 'x', kind: 'filesystem', root: 'D:\\x', access: 'write' }).ok, false);
    assert.strictEqual(validateSourcePayload({ sourceId: 'x', kind: 'filesystem', root: 'D:\\x', access: 'both', storageRootId: '..\\x' }).ok, false);
  });

  check('source payload: rejects bad source IDs and out-of-range ports', () => {
    assert.strictEqual(validateSourcePayload({ sourceId: 'has space', kind: 'csv', root: 'D:\\x' }).ok, false);
    assert.strictEqual(validateSourcePayload({ sourceId: '-x', kind: 'csv', root: 'D:\\x' }).ok, false);
    assert.strictEqual(validateSourcePayload({ sourceId: 'x', kind: 'mysql', connection: { host: 'h', port: 70000, user: 'u', database: 'd' } }).ok, false);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
