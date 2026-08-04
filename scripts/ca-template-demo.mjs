/**
 * Drive the CA / TAX-PRACTICE SECTOR TEMPLATE end to end against the live dev DB
 * (FR-INV-11, on FR-INV-01/05/06/07/09).
 *
 *   pnpm ca:template
 *
 * The point of this script is not "the template applied without a 500". It is
 * the claim the template makes about itself: that everything it seeds is
 * ORDINARY, EDITABLE TENANT DATA — a starting point, not a locked list.
 *
 * So it proves that claim by symmetry. It applies the template to a brand-new
 * tenant, then does the same two things to a SEEDED element and to a
 * HAND-TYPED one ("Passport Number") and demands the results be identical:
 * both land at version 1 on create, both fork to version 2 on edit, both
 * produce an audit entry on the S5 hash chain, and both appear in the RoPA.
 * If seeded rows were special in any way, that symmetry is where it would show.
 *
 * Needs the API running (pnpm dev:api) and the two migrations applied.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { totp } = await import(
  `file:///${join(ROOT, 'backend/dist/modules/identity/crypto/totp.js').replace(/\\/g, '/')}`
);
const { base32Decode } = await import(
  `file:///${join(ROOT, 'backend/dist/modules/identity/crypto/base32.js').replace(/\\/g, '/')}`
);

const env = existsSync(join(ROOT, '.env'))
  ? Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
  : {};
const BASE = process.env.API_URL ?? `http://localhost:${env.API_PORT ?? 3001}`;

const step = (n, s) => console.log(`\n${'='.repeat(76)}\n${n}. ${s}\n${'='.repeat(76)}`);
const ok = (s) => console.log(`   ✓ ${s}`);
const info = (s) => console.log(`     ${s}`);
const bad = (s) => {
  console.error(`   ✗ ${s}`);
  process.exitCode = 1;
};

async function api(method, path, { body, token, expect, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const json = await res.json().catch(() => null);
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} -> expected ${expect}, got ${res.status} ${JSON.stringify(json)}`);
  }
  if (expect === undefined && res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

try {
  await fetch(`${BASE}/health`);
} catch {
  console.error(`\nNothing is answering on ${BASE}. Start it:  pnpm dev:api\n`);
  process.exit(1);
}

// What the SOP actually names. Kept here, spelled out, so the assertions below
// check the template against the document rather than against itself.
const SOP_ELEMENTS = ['Aadhaar Card', 'PAN Card', 'Bank Account Details (account number + IFSC)', 'Date of Birth'];
const SOP_ENGAGEMENTS = [
  'Income Tax Return (ITR) filing',
  'PAN registration on the Income Tax Portal',
  'GST Registration',
  'PTRC Registration',
  'PTEC Registration',
  'TAN / TDS Registration',
];
const SOP_SYSTEMS = [
  'Official Office WhatsApp',
  'Official Office Email',
  'Secure Client Portal',
  "Firm's Document Server / Storage",
];
const SOP_VENDORS = ['Income Tax Portal', 'GST Portal', "Client's Bank"];

// ===========================================================================
step(1, 'A brand-new tenant — nothing seeded, nothing carried over');
// ===========================================================================
const sfx = randomBytes(3).toString('hex');
const reg = await api('POST', '/auth/register', {
  body: {
    organisationName: `Sharma & Associates, Chartered Accountants ${sfx}`,
    ownerName: 'Priya Sharma',
    ownerEmail: `priya.${sfx}@example.test`,
    password: 'Correct-Horse-Battery-9!',
  },
});
const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
const mfaSecret = base32Decode(enrol.secret);
const confirmed = await api('POST', '/auth/mfa/confirm', {
  body: { challengeToken: reg.mfaEnrolmentToken, code: totp(mfaSecret) },
});
const token = confirmed.accessToken;
ok(`fresh tenant registered and MFA-enrolled (owner: priya.${sfx}@example.test)`);

const before = await api('GET', '/inventory/register', { token });
const beforeSystems = await api('GET', '/inventory/systems', { token });
const beforeVendors = await api('GET', '/inventory/vendors', { token });
if (before.elements.length || beforeSystems.systems.length || beforeVendors.vendors.length) {
  bad('the new tenant is not empty — the rest of this run proves nothing');
} else {
  ok('registers are empty: 0 elements, 0 systems, 0 vendors');
}

// ===========================================================================
step(2, 'The catalog offers the CA / tax-practice template');
// ===========================================================================
const catalog = await api('GET', '/inventory/sector-templates', { token });
const ca = catalog.templates.find((t) => t.sector === 'ca_tax_practice');
if (!ca) {
  bad('no ca_tax_practice template in the catalog — did migration 1737002500000 run?');
  process.exit(1);
}
ok(`"${ca.name}" — ${ca.elementCount} elements, ${ca.systemCount} systems, ${ca.vendorCount} vendors`);
for (const other of catalog.templates.filter((t) => t.sector !== 'ca_tax_practice')) {
  if (other.systemCount !== 0 || other.vendorCount !== 0) {
    bad(`${other.sector} unexpectedly gained systems/vendors — the shape change was not backward-compatible`);
  }
}
ok('the four pre-existing templates are unchanged (0 systems, 0 vendors) — shape change is backward-compatible');

// ===========================================================================
step(3, 'ONE action at onboarding: apply the template');
// ===========================================================================
const applied = await api('POST', `/inventory/sector-templates/${ca.id}/apply`, { token, expect: 201 });
ok(
  `applied: ${applied.created.length} element(s), ${applied.createdSystems.length} system(s), ` +
    `${applied.createdVendors.length} vendor(s) — in a single request`,
);

// ===========================================================================
step(4, 'Every element, purpose, system and vendor the SOP names is present');
// ===========================================================================
const entries = await api('GET', '/inventory/register', { token });
const categories = entries.elements.map((e) => e.category);
for (const want of SOP_ELEMENTS) {
  if (categories.includes(want)) ok(`data element: ${want}`);
  else bad(`MISSING data element: ${want}`);
}

const purposesByElement = new Map();
const allPurposeNames = new Set();
let indicativeCount = 0;
let nonIndicative = [];
for (const e of entries.elements) {
  const res = await api('GET', `/inventory/register/${e.id}/purposes`, { token });
  purposesByElement.set(e.category, res.purposes);
  for (const p of res.purposes) {
    allPurposeNames.add(p.purposeName);
    if (/INDICATIVE starting point — confirm the exact statutory period/.test(p.retentionPeriod)) {
      indicativeCount += 1;
    } else {
      nonIndicative.push(`${e.category} / ${p.purposeName}: "${p.retentionPeriod}"`);
    }
  }
}
console.log('');
for (const want of SOP_ENGAGEMENTS) {
  if (allPurposeNames.has(want)) {
    const on = [...purposesByElement.entries()]
      .filter(([, ps]) => ps.some((p) => p.purposeName === want))
      .map(([cat]) => cat);
    ok(`engagement is its OWN purpose: ${want}`);
    info(`on: ${on.join(', ')}`);
  } else {
    bad(`MISSING engagement purpose: ${want}`);
  }
}
if (allPurposeNames.size !== SOP_ENGAGEMENTS.length) {
  bad(`expected exactly the ${SOP_ENGAGEMENTS.length} SOP engagements, found ${allPurposeNames.size}`);
} else {
  ok(`exactly ${allPurposeNames.size} distinct purposes — one per SOP engagement, not one generic bucket`);
}
console.log('');
if (nonIndicative.length === 0) {
  ok(`all ${indicativeCount} seeded retention periods carry the INDICATIVE caveat in the STORED string`);
  info(`e.g. "${purposesByElement.get('PAN Card')[0].retentionPeriod}"`);
} else {
  bad(`${nonIndicative.length} retention period(s) lack the caveat:\n       ${nonIndicative.join('\n       ')}`);
}

console.log('');
const systems = await api('GET', '/inventory/systems', { token });
for (const want of SOP_SYSTEMS) {
  const s = systems.systems.find((x) => x.name === want);
  if (s) ok(`system: ${want} (${s.systemType}) — v${s.versionNumber}`);
  else bad(`MISSING system: ${want}`);
}
const docServer = systems.systems.find((s) => s.name === "Firm's Document Server / Storage");
if (docServer?.accessControlNote?.includes('need-to-know basis')) {
  ok('the document server carries an access-control policy note (the field that did not exist before)');
  info(`"${docServer.accessControlNote}"`);
} else {
  bad('the document server has no access-control note');
}
const withNotes = systems.systems.filter((s) => s.accessControlNote).length;
ok(`${withNotes}/${systems.systems.length} systems carry an access-control note`);

console.log('');
const vendors = await api('GET', '/inventory/vendors', { token });
for (const want of SOP_VENDORS) {
  const v = vendors.vendors.find((x) => x.name === want);
  if (v) ok(`vendor: ${want}${v.country ? ` (${v.country})` : ''} — v${v.versionNumber}`);
  else bad(`MISSING vendor: ${want}`);
}

console.log('');
const aadhaar = entries.elements.find((e) => e.category === 'Aadhaar Card');
const aadhaarSystems = await api('GET', `/inventory/register/${aadhaar.id}/systems`, { token });
const aadhaarVendors = await api('GET', `/inventory/register/${aadhaar.id}/vendors`, { token });
if (aadhaarSystems.systems.length === 4 && aadhaarVendors.vendors.length === 2) {
  ok('elements are LINKED to their systems and vendors — Aadhaar Card: 4 systems, 2 vendors');
} else {
  bad(
    `Aadhaar Card links wrong: ${aadhaarSystems.systems.length} systems, ${aadhaarVendors.vendors.length} vendors`,
  );
}

// ===========================================================================
step(5, 'Seeded == hand-typed: add "Passport Number" the manual way');
// ===========================================================================
const passport = await api('POST', '/inventory/register', {
  token,
  expect: 201,
  body: {
    category: 'Passport Number',
    description: 'Alternative identity proof accepted for some engagements.',
    storageLocation: "Firm's document server — client folder",
  },
});
const passportFull = await api('GET', `/inventory/register/${passport.id}`, { token });
const seededPan = entries.elements.find((e) => e.category === 'PAN Card');
const seededPanFull = await api('GET', `/inventory/register/${seededPan.id}`, { token });

const manualV1 = passportFull.versions.length === 1 && passportFull.versions[0].versionNumber === 1;
const seededV1 = seededPanFull.versions.length === 1 && seededPanFull.versions[0].versionNumber === 1;
if (manualV1 && seededV1) {
  ok('both land at exactly one version, numbered 1 — the seeded row is not pre-aged or special');
} else {
  bad(`version-on-create differs: manual=${passportFull.versions.length}, seeded=${seededPanFull.versions.length}`);
}
const manualKeys = Object.keys(passportFull).sort().join(',');
const seededKeys = Object.keys(seededPanFull).sort().join(',');
if (manualKeys === seededKeys) ok('both expose an identical field set — no marker distinguishes them');
else bad(`field sets differ:\n       manual: ${manualKeys}\n       seeded: ${seededKeys}`);

// A purpose typed by hand onto the hand-typed element.
await api('POST', `/inventory/register/${passport.id}/purposes`, {
  token,
  expect: 201,
  body: {
    purposeName: 'Income Tax Return (ITR) filing',
    legalBasis: 'contract',
    legalBasisNote: 'Identity proof for the filing engagement.',
    retentionPeriod: '8 years from the end of the relevant assessment year.',
  },
});
await api('POST', `/inventory/register/${passport.id}/systems`, {
  token,
  expect: 201,
  body: { systemId: docServer.id },
});
ok('a purpose and a system link attach to the hand-typed element through the same endpoints');

// ===========================================================================
step(6, 'Editing versions correctly — seeded and hand-typed alike');
// ===========================================================================
await api('PATCH', `/inventory/register/${seededPan.id}`, {
  token,
  body: {
    category: 'PAN Card (copy)',
    description: 'Edited after seeding — proving a seeded row is not locked.',
    storageLocation: "Firm's document server — client folder, prescribed naming convention",
  },
});
const seededAfter = await api('GET', `/inventory/register/${seededPan.id}`, { token });
if (
  seededAfter.versions.length === 2 &&
  seededAfter.versions[0].versionNumber === 2 &&
  seededAfter.versions[0].category === 'PAN Card (copy)' &&
  seededAfter.versions[1].versionNumber === 1 &&
  seededAfter.versions[1].category === 'PAN Card'
) {
  ok('SEEDED element edited -> v2 appended, v1 preserved verbatim ("PAN Card" -> "PAN Card (copy)")');
} else {
  bad(`seeded element did not version correctly: ${JSON.stringify(seededAfter.versions.map((v) => v.versionNumber))}`);
}

await api('PATCH', `/inventory/register/${passport.id}`, {
  token,
  body: {
    category: 'Passport Number (copy)',
    description: 'Alternative identity proof accepted for some engagements.',
    storageLocation: "Firm's document server — client folder",
  },
});
const manualAfter = await api('GET', `/inventory/register/${passport.id}`, { token });
if (
  manualAfter.versions.length === 2 &&
  manualAfter.versions[0].versionNumber === 2 &&
  manualAfter.versions[1].versionNumber === 1
) {
  ok('HAND-TYPED element edited -> v2 appended, v1 preserved — identical behaviour');
} else {
  bad(`hand-typed element did not version correctly: ${JSON.stringify(manualAfter.versions.map((v) => v.versionNumber))}`);
}

// Same test on a seeded SYSTEM — the entity that gained the new column.
await api('PATCH', `/inventory/systems/${docServer.id}`, {
  token,
  body: {
    name: docServer.name,
    systemType: docServer.systemType,
    description: docServer.description,
    hostingLocation: 'On-premise — Pune office, locked server room',
    accessControlNote:
      'Access restricted to the two staff on the engagement; reviewed quarterly. Replaced the seeded starting text.',
  },
});
const docAfter = await api('GET', `/inventory/systems/${docServer.id}`, { token });
if (
  docAfter.versions.length === 2 &&
  docAfter.versions[0].accessControlNote.startsWith('Access restricted to the two staff') &&
  docAfter.versions[1].accessControlNote.includes('need-to-know basis')
) {
  ok('SEEDED system edited -> v2 with the firm\'s real policy; the seeded wording survives as v1 evidence');
} else {
  bad('seeded system did not version its access-control note correctly');
}

// ===========================================================================
step(7, 'The S5 audit chain recorded all of it — and still verifies');
// ===========================================================================
const audit = await api('GET', '/audit?limit=200', { token });
const byAction = (a) => audit.entries.filter((e) => e.action === a);
const expectAudit = [
  ['inventory.sector_template.applied', 1],
  ['inventory.register.entry_created', 1],
  ['inventory.register.entry_updated', 2],
  ['inventory.system.updated', 1],
];
for (const [action, atLeast] of expectAudit) {
  const n = byAction(action).length;
  if (n >= atLeast) ok(`${action}: ${n} entr${n === 1 ? 'y' : 'ies'}`);
  else bad(`${action}: expected at least ${atLeast}, found ${n}`);
}
const applyEntry = byAction('inventory.sector_template.applied')[0];
if (applyEntry?.afterState?.createdSystems?.length === 4 && applyEntry?.afterState?.createdEntries?.length === 4) {
  ok('the apply entry names every element, system and vendor it seeded');
  info(`reason: ${applyEntry.reason}`);
} else {
  bad('the apply audit entry does not enumerate what it seeded');
}
const seededEdit = byAction('inventory.register.entry_updated').find((e) => e.beforeState?.category === 'PAN Card');
const manualEdit = byAction('inventory.register.entry_updated').find(
  (e) => e.beforeState?.category === 'Passport Number',
);
if (seededEdit && manualEdit) {
  const shape = (e) => Object.keys(e.beforeState).sort().join(',') + '|' + Object.keys(e.afterState).sort().join(',');
  if (shape(seededEdit) === shape(manualEdit)) {
    ok('the audit entry for editing a SEEDED element is structurally identical to the hand-typed one');
    info(`seeded: ${seededEdit.reason}`);
    info(`typed:  ${manualEdit.reason}`);
  } else {
    bad('audit entries for seeded vs hand-typed edits have different shapes');
  }
} else {
  bad('could not find both edit audit entries');
}
const chain = await api('GET', '/audit/verify', { token });
if (chain.intact && chain.breaks.length === 0) {
  ok(`hash chain intact across ${chain.entriesChecked} entries, 0 breaks`);
} else {
  bad(`hash chain BROKEN: ${JSON.stringify(chain)}`);
}

// ===========================================================================
step(8, 'The RoPA export reads correctly, end to end');
// ===========================================================================
const pdfRes = await api('POST', '/inventory/ropa/export', { token, body: { format: 'pdf' }, raw: true });
const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
if (pdfBuf.subarray(0, 4).toString() !== '%PDF') bad('the RoPA export is not a PDF');
const pdfText = ascii(extractPdfText(pdfBuf));
ok(`RoPA PDF generated: ${pdfBuf.length} bytes`);

// Note the edited names: the export must show the CURRENT version of each
// element, so the seeded original ("PAN Card") is expected to be replaced by
// its edit ("PAN Card (copy)").
const mustAppear = [
  'Aadhaar Card',
  'PAN Card (copy)',
  'Bank Account Details (account number + IFSC)',
  'Date of Birth',
  'Passport Number (copy)',
  ...SOP_ENGAGEMENTS,
  ...SOP_VENDORS,
  'ACCESS CONTROL', // labelValue() upper-cases the label
  'reviewed quarterly', // the access-control policy as edited in step 6
  'INDICATIVE starting point',
];
const missing = mustAppear.filter((t) => !pdfText.includes(ascii(t)));
if (missing.length === 0) {
  ok('every element, engagement, vendor, the access-control line and the INDICATIVE caveat appear in the PDF');
} else {
  bad(`missing from the RoPA PDF: ${missing.join(' | ')}`);
}
if (pdfText.includes(ascii('PAN Card (copy)'))) {
  ok('the PDF shows the CURRENT version of the edited element, not the seeded original');
} else {
  bad('the PDF does not show the edited version of the seeded element');
}

const xlsxRes = await api('POST', '/inventory/ropa/export', { token, body: { format: 'xlsx' }, raw: true });
const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
ok(`RoPA XLSX generated: ${xlsxBuf.length} bytes`);

// Read it back with the same library that wrote it — proves it is a genuinely
// parseable workbook, not just bytes, and lets us assert on real cells.
const require_ = createRequire(import.meta.url);
const ExcelJS = require_(require_.resolve('exceljs', { paths: [join(ROOT, 'backend')] }));
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(xlsxBuf);
const sheet = wb.worksheets[0];
const headers = (sheet.getRow(4).values ?? []).filter(Boolean).map(String);
if (headers.includes('Access control')) {
  ok(`XLSX header row carries the new column: ${headers.join(' | ')}`);
} else {
  bad(`XLSX header row is missing "Access control": ${headers.join(' | ')}`);
}
const acIdx = headers.indexOf('Access control') + 1;
const retIdx = headers.indexOf('Retention period') + 1;
const catIdx = headers.indexOf('Category') + 1;
const purIdx = headers.indexOf('Purpose') + 1;
const vendIdx = headers.indexOf('Vendors / recipients') + 1;

const dataRows = [];
sheet.eachRow((row, n) => {
  if (n > 4) dataRows.push(row);
});
ok(`${dataRows.length} data rows (one per element x purpose — the standard flat RoPA shape)`);

const cell = (r, i) => String(r.getCell(i).value ?? '');
const engagementsInSheet = new Set(dataRows.map((r) => cell(r, purIdx)).filter(Boolean));
const missingEng = SOP_ENGAGEMENTS.filter((e) => !engagementsInSheet.has(e));
if (missingEng.length === 0) ok('all six SOP engagements appear as their own purpose rows');
else bad(`engagements missing from the XLSX: ${missingEng.join(' | ')}`);

const seededRows = dataRows.filter((r) => cell(r, catIdx) === 'PAN Card (copy)');
const typedRows = dataRows.filter((r) => cell(r, catIdx) === 'Passport Number (copy)');
if (seededRows.length === 6 && typedRows.length === 1) {
  ok('the edited SEEDED element (6 purpose rows) and the HAND-TYPED one (1) sit side by side, same shape');
} else {
  bad(`row counts wrong: seeded=${seededRows.length} (want 6), typed=${typedRows.length} (want 1)`);
}
const uncaveated = seededRows.filter((r) => !cell(r, retIdx).includes('INDICATIVE starting point'));
if (uncaveated.length === 0) ok('every seeded retention cell in the export carries the INDICATIVE caveat');
else bad(`${uncaveated.length} seeded retention cell(s) lost the caveat in export`);

// Step 6 replaced the document server's seeded placeholder wording. A document
// describing CURRENT practice must carry the replacement, not the placeholder.
const acCell = seededRows[0] ? cell(seededRows[0], acIdx) : '';
// The OTHER three systems still carry their seeded starting text — expected,
// and the reason this checks for the replaced wording specifically.
if (acCell.includes('reviewed quarterly') && !acCell.includes('need-to-know basis')) {
  ok("the Access control cell carries the document server's CURRENT policy, not the wording it replaced");
  info(`"${acCell.slice(0, 130)}…"`);
} else {
  bad(`unexpected Access control cell: "${acCell.slice(0, 200)}"`);
}
const vendCell = seededRows[0] ? cell(seededRows[0], vendIdx) : '';
if (SOP_VENDORS.every((v) => vendCell.includes(v))) {
  ok('the Vendors / recipients cell names all three SOP recipients with their transfer notes');
} else {
  bad(`vendors cell incomplete: "${vendCell}"`);
}

console.log(
  `\n${'='.repeat(76)}\n${process.exitCode ? 'FAILED — see ✗ above' : 'All checks passed.'}\n${'='.repeat(76)}\n`,
);

/**
 * Extract readable text from a pdfkit-produced PDF. Content streams are
 * Flate-compressed and the text inside is hex-encoded WinAnsi, so both layers
 * have to come off — same approach as scripts/notify-and-evidence-demo.mjs.
 */
function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  let out = '';
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    let text;
    try {
      text = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    const hexRe = /<([0-9A-Fa-f]+)>/g;
    let hm;
    while ((hm = hexRe.exec(text))) out += Buffer.from(hm[1], 'hex').toString('latin1');
    out += '\n';
  }
  return out;
}

/**
 * Fold non-ASCII (em dashes, curly quotes) to '.' so a WinAnsi-vs-UTF-8
 * encoding difference cannot fail an assertion that is really about wording.
 */
function ascii(s) {
  return s.replace(/[^\x20-\x7e\n]/g, '.');
}
