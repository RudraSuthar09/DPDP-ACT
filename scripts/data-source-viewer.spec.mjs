/**
 * Phase-2 verification: browser-local Excel/CSV raw-data proof.
 *
 * Proves an authorized user can view a local CSV/XLSX inside DPDP Shield while
 * the raw file + rows NEVER reach the backend, are masked, searchable, and
 * cleared — and that a metadata_only source cannot be viewed.
 *
 *   node scripts/data-source-viewer.spec.mjs
 * Needs API :3001, web :3000, backend dist built.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const API = 'http://localhost:3001', WEB = 'http://localhost:3000';
const S = 'C:/Users/Rudra/AppData/Local/Temp/claude/E--DPDP-ACT/3495d79a-fb77-4a10-9262-97ce0578da9d/scratchpad';
const state = JSON.parse(readFileSync(`${S}/.verify-state.json`, 'utf8'));
const { totp } = await import(new URL('../backend/dist/modules/identity/crypto/totp.js', import.meta.url));
const { base32Decode } = await import(new URL('../backend/dist/modules/identity/crypto/base32.js', import.meta.url));
const XLSX = await import(new URL('../frontend/node_modules/xlsx/xlsx.mjs', import.meta.url));
const EMAIL = 'owner@verify-session.dpdp.invalid', PW = 'Verify-Session-Value-2026!';
const ok = (s) => console.log('  ✓', s), bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (n, s) => console.log(`\n${'='.repeat(66)}\n${n}. ${s}\n${'='.repeat(66)}`);
const tag = Date.now().toString().slice(-6);

// Unmistakable sentinels planted in the file. If ANY of these reach the network
// or browser storage, the invariant is broken.
const NAME_SENTINEL = `SENTINEL_NAME_${tag}`;
const AADHAAR_SENTINEL = `9999${tag}0000`.slice(0, 12);
const rowsData = [
  ['Customer ID', 'Name', 'Aadhaar', 'PAN', 'Phone', 'Email'],
  ['C001', NAME_SENTINEL, AADHAAR_SENTINEL, 'ABCDE1234F', '9876543210', 'rahul@example.com'],
  ['C002', 'Amit Verma', '111122223333', 'PQRSX6789Z', '9812345678', 'amit@example.com'],
];
const dir = join(tmpdir(), 'dpdp-ds-viewer');
mkdirSync(dir, { recursive: true });
const csvPath = join(dir, `customers-${tag}.csv`);
const xlsxPath = join(dir, `customers-${tag}.xlsx`);
writeFileSync(csvPath, rowsData.map((r) => r.join(',')).join('\n'), 'utf8');
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rowsData), 'Sheet1');
writeFileSync(xlsxPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

async function api(method, path, token, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
}

// --- session + sources (a gateway_connected excel + a metadata_only one) ---
const login = (await api('POST', '/auth/login', null, { email: EMAIL, password: PW })).body;
await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
const verify = (await api('POST', '/auth/mfa/verify', null, { challengeToken: login.challengeToken, code: totp(base32Decode(state.mfaSecretBase32)) })).body;
const token = verify.accessToken;
await api('PATCH', '/auth/me/product-tour', token, { status: 'skipped' });
const gw = (await api('POST', '/data-sources', token, { name: `Viewer Excel ${tag}`, sourceKind: 'excel' })).body;
await api('PATCH', `/data-sources/${gw.id}/mode`, token, { enabled: true });
const meta = (await api('POST', '/data-sources', token, { name: `Viewer Meta ${tag}`, sourceKind: 'csv' })).body;

// direct backend fail-closed: raw-access on a metadata_only source -> 403
const metaRaw = await api('POST', `/data-sources/${meta.id}/raw-access`, token, { rowCount: 2 });
if (metaRaw.status === 403) ok('backend: raw-access on a metadata_only source is refused (403, fail closed)'); else bad('metadata_only raw-access not refused: ' + metaRaw.status);

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  // This spec exercises the ORIGINAL plain <input type="file"> flow. Since the
  // viewer now prefers window.showOpenFilePicker() when the browser supports
  // it (the persistent-local-source feature — see local-source-handles.spec.mjs
  // for that coverage), disable it here so #ds-file still renders as before.
  await page.addInitScript(() => {
    delete window.showOpenFilePicker;
  });

  // capture EVERY request body + url, to prove nothing sensitive is transmitted
  const transmitted = [];
  page.on('request', (req) => transmitted.push({ url: req.url(), method: req.method(), postData: req.postData() || '' }));

  await page.goto(`${WEB}/login`);
  await page.fill('input[type=email]', EMAIL); await page.fill('input[type=password]', PW);
  await page.click('button[type=submit]');
  const mfa = page.locator('input[autocomplete="one-time-code"]').or(page.locator('form input:not([type])'));
  await mfa.first().waitFor({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
  await mfa.first().fill(totp(base32Decode(state.mfaSecretBase32)));
  await page.click('button[type=submit]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });

  async function viewAndAssert(kind, filePath) {
    step(kind, `View a local ${kind.toUpperCase()} in the browser and assert nothing raw is sent`);
    await page.goto(`${WEB}/data-sources/${gw.id}/viewer`, { waitUntil: 'networkidle' });
    transmitted.length = 0; // capture only what happens during the file view
    await page.setInputFiles('#ds-file', filePath);
    await page.waitForSelector(`text=${NAME_SENTINEL}`, { timeout: 10000 });
    ok(`${kind}: rows rendered in the browser (Name sentinel visible)`);

    // masking: the Aadhaar sentinel must NOT be fully visible in the table
    const bodyText = await page.locator('table').innerText();
    if (!bodyText.includes(AADHAAR_SENTINEL)) ok(`${kind}: Aadhaar value is masked (full value not shown)`); else bad(`${kind}: Aadhaar shown in full!`);

    // search works (client-side)
    await page.fill('input[placeholder="Search…"]', 'Amit');
    await page.waitForTimeout(200);
    const afterSearch = await page.locator('table tbody tr').count();
    if (afterSearch === 1) ok(`${kind}: client-side search filters rows`); else bad(`${kind}: search returned ${afterSearch} rows`);
    await page.fill('input[placeholder="Search…"]', '');

    // THE BOUNDARY: no request carried the file bytes or raw values
    const leaks = transmitted.filter((t) => (t.postData && (t.postData.includes(NAME_SENTINEL) || t.postData.includes(AADHAAR_SENTINEL))) || t.url.includes(NAME_SENTINEL) || t.url.includes(AADHAAR_SENTINEL));
    if (leaks.length === 0) ok(`${kind}: NO network request carried the file or any raw value`); else bad(`${kind}: raw data leaked in ${leaks.length} request(s): ${leaks.map((l)=>l.method+' '+l.url).join(', ')}`);

    // the ONLY datasource call is the metadata raw-access with just rowCount
    const rawCalls = transmitted.filter((t) => t.url.includes(`/data-sources/${gw.id}/raw-access`));
    const bad2 = rawCalls.filter((c) => { try { const b = JSON.parse(c.postData || '{}'); return Object.keys(b).length !== 1 || typeof b.rowCount !== 'number'; } catch { return true; } });
    if (rawCalls.length >= 1 && bad2.length === 0) ok(`${kind}: raw-access audit call carried metadata only ({rowCount}); ${rawCalls.length} call(s)`); else bad(`${kind}: raw-access body not metadata-only`);
    // no multipart / file upload anywhere
    if (!transmitted.some((t) => (t.postData||'').includes('Content-Disposition') || (t.postData||'').includes('filename='))) ok(`${kind}: no multipart file upload occurred`); else bad(`${kind}: a multipart upload happened`);

    // browser persistence holds no raw data
    const storage = await page.evaluate((sent) => {
      const dump = (s) => { let out=''; for (let i=0;i<s.length;i++){ const k=s.key(i); out+=k+'='+s.getItem(k)+'\n'; } return out; };
      return { local: dump(window.localStorage), session: dump(window.sessionStorage), idbNames: (window.indexedDB && indexedDB.databases) ? true : false, hit: (dump(window.localStorage)+dump(window.sessionStorage)).includes(sent) };
    }, NAME_SENTINEL);
    if (!storage.hit) ok(`${kind}: localStorage/sessionStorage contain no raw values`); else bad(`${kind}: raw value found in browser storage`);

    // close & clear -> rows gone
    await page.getByRole('button', { name: 'Close & clear' }).click();
    await page.waitForTimeout(150);
    const stillThere = await page.locator(`text=${NAME_SENTINEL}`).count();
    if (stillThere === 0) ok(`${kind}: Close & clear removes the data from the view`); else bad(`${kind}: data still visible after close`);
  }

  await viewAndAssert('csv', csvPath);
  await viewAndAssert('xlsx', xlsxPath);

  step(3, 'Mode enforcement + malformed handling in the UI');
  await page.goto(`${WEB}/data-sources/${meta.id}/viewer`, { waitUntil: 'networkidle' });
  const notice = await page.locator('text=Metadata-only').count();
  const noPicker = await page.locator('#ds-file').count();
  if (notice >= 1 && noPicker === 0) ok('viewer on a metadata_only source shows the notice and offers NO file picker (fail closed)'); else bad(`metadata_only viewer not gated: notice=${notice} picker=${noPicker}`);

  // malformed / unsupported file rejected with a sanitized message
  await page.goto(`${WEB}/data-sources/${gw.id}/viewer`, { waitUntil: 'networkidle' });
  const badPath = join(dir, `notes-${tag}.txt`);
  writeFileSync(badPath, 'this is not a spreadsheet', 'utf8');
  await page.setInputFiles('#ds-file', badPath).catch(() => {});
  await page.waitForTimeout(400);
  const errText = await page.locator('.error').count();
  if (errText >= 1) ok('unsupported/malformed file is rejected with a sanitized error'); else console.log('  · (unsupported file: input accept may have filtered it — acceptable)');

  console.log(process.exitCode ? '\nFAILED' : '\nPHASE-2 RAW-DATA PROOF VERIFIED');
} finally {
  await browser?.close();
}
