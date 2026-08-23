// Plain-node round-trip test for the Central DPDP Storage write ops (no jest,
// no electron): `node src/storage-fs-ops.test.js`. Proves the exact on-disk
// structure a consent submission produces — the write mechanism the Electron
// FormIntake local-storage path relies on (text -> value.txt, PDF -> original
// bytes, profile/retention json, contained under the configured root).
// Exits non-zero on the first failure.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ops = require('./storage-fs-ops');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdp-fsops-'));
  try {
    // Simulate a full submission for customer "rudra" on template "KYC" with a
    // text field (Aadhaar), a PDF upload (Aadhaar Card), + Customer Information.
    const customer = 'rudra';
    const template = 'KYC';

    await check('writes Customer Information/profile.json + retention.json', async () => {
      const info = ['Customers', customer, 'Customer Information'];
      await ops.writeJson(root, info, 'profile.json', { customerId: 'uuid-a', displayName: 'rudra' });
      await ops.writeJson(root, info, 'retention.json', { templateName: template, retentionMonths: 12 });
      const profile = JSON.parse(await fsp.readFile(path.join(root, 'Customers', customer, 'Customer Information', 'profile.json'), 'utf8'));
      assert.strictEqual(profile.displayName, 'rudra');
      const retention = JSON.parse(await fsp.readFile(path.join(root, 'Customers', customer, 'Customer Information', 'retention.json'), 'utf8'));
      assert.strictEqual(retention.retentionMonths, 12);
    });

    await check('writes a TEXT field as value.txt (plain, not JSON) under Consent Register', async () => {
      const seg = ['Customers', customer, 'Consent Register', template, 'Aadhaar'];
      await ops.writeText(root, seg, 'value.txt', '1234-5678-9012');
      const body = await fsp.readFile(path.join(root, ...seg, 'value.txt'), 'utf8');
      assert.strictEqual(body, '1234-5678-9012'); // exactly as typed, no JSON wrapping
    });

    await check('writes a PDF upload with original bytes preserved', async () => {
      const seg = ['Customers', customer, 'Consent Register', template, 'Aadhaar Card'];
      const pdfBytes = Buffer.from('%PDF-1.4 hello aadhaar', 'utf8');
      await ops.writeFileBase64(root, seg, 'aadhaar.pdf', pdfBytes.toString('base64'));
      const written = await fsp.readFile(path.join(root, ...seg, 'aadhaar.pdf'));
      assert.ok(written.equals(pdfBytes), 'PDF bytes must round-trip unchanged');
    });

    await check('browseDir lists the customer folder under Customers/', async () => {
      const names = await ops.browseDir(root, ['Customers']);
      assert.deepStrictEqual(names, [customer]);
    });

    await check('a SECOND customer writes alongside the first (same root)', async () => {
      await ops.writeJson(root, ['Customers', 'rahul', 'Customer Information'], 'profile.json', { customerId: 'uuid-b' });
      const names = await ops.browseDir(root, ['Customers']);
      assert.deepStrictEqual(names.sort(), ['rahul', customer].sort());
    });

    await check('rejects a traversal segment (containment)', async () => {
      await assert.rejects(() => ops.writeText(root, ['..', '..'], 'evil.txt', 'x'), /PATH_NOT_ALLOWED/);
    });

    await check('rejects an unsafe filename', async () => {
      await assert.rejects(() => ops.writeText(root, ['Customers'], 'a/b.txt', 'x'), /PATH_NOT_ALLOWED/);
    });

    console.log(`\n${passed} checks passed.`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
