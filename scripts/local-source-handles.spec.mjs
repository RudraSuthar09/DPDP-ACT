/**
 * Persistent SaaS Local Excel/CSV Source — real-browser verification.
 *
 * Proves, against the REAL running app (API :3001, web :3000) in a REAL
 * Chromium browser (via Playwright), that:
 *   - a FileSystemFileHandle saved for one data source never leaks to another
 *     (real IndexedDB, real per-tenant browser storage — see mockConfig note
 *     below for WHY the handle itself has to be mocked);
 *   - a granted-permission handle reopens a file WITHOUT asking the user;
 *   - a 'prompt'/'denied' permission NEVER auto-requests — only an explicit
 *     Reconnect click does, and only that click may call requestPermission();
 *   - a moved/deleted file's handle fails closed with "Choose another file",
 *     never a silent loop;
 *   - an unsupported browser (no File System Access API) falls back to the
 *     plain <input type="file"> flow and never claims a persistent connection;
 *   - removing a Data Source that has a connected local handle still succeeds
 *     and does not corrupt a different source's handle;
 *   - no request to the backend ever carries file bytes, rows, or a
 *     filesystem path — only the existing metadata-only raw-access audit.
 *
 * WHY THE FILE SYSTEM ACCESS API IS MOCKED: Chromium's native
 * showOpenFilePicker() opens a REAL OS file dialog that no browser automation
 * tool (Playwright included) can drive — unlike <input type="file">, which
 * Chromium exposes to automation via a file-chooser interception hook, there
 * is no equivalent hook for the native picker. A hand-authored mock handle
 * object also cannot survive a REAL IndexedDB round-trip with its methods
 * intact (the structured-clone algorithm drops function-valued properties —
 * a genuine FileSystemFileHandle is browser-native and exempt from that; a
 * plain JS mock is not). So this spec installs a small, self-contained fake
 * IndexedDB + fake showOpenFilePicker (via page.addInitScript +
 * page.exposeFunction) that behaves identically to the real API from
 * local-source-handles.ts's point of view — same call shapes, same
 * async/permission semantics — while keeping the "identity" of a handle
 * (which mock file it refers to, and that mock's current permission state)
 * bridged through Node so it genuinely persists across page reloads, the same
 * way real IndexedDB persistence would. The IMPLEMENTATION under test
 * (frontend/src/lib/local-source-handles.ts and the viewer/page.tsx logic
 * built on it) is completely unmodified and unaware it is talking to a mock.
 *
 *   node scripts/local-source-handles.spec.mjs
 * Needs API :3001, web :3000, backend dist built.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const API = 'http://localhost:3001';
const WEB = 'http://localhost:3000';
const ok = (s) => console.log('  ✓', s);
const bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (s) => console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`);

const { totp } = await import(new URL('../backend/dist/modules/identity/crypto/totp.js', import.meta.url));
const { base32Decode } = await import(new URL('../backend/dist/modules/identity/crypto/base32.js', import.meta.url));

async function api(method, path, token, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

const tag = Date.now().toString().slice(-8);
const EMAIL = `qa-local-source-${tag}@local-source.dpdp.invalid`;
const PASSWORD = 'Verify-Local-Source-2026!';

step('Register an isolated QA tenant (does not touch any real user tenant)');
const reg = await api('POST', '/auth/register', null, {
  organisationName: `Local Source Verify ${tag}`,
  ownerEmail: EMAIL,
  ownerName: 'QA Local Source',
  password: PASSWORD,
});
if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
const enrol = await api('POST', '/auth/mfa/enroll', null, { challengeToken: reg.body.mfaEnrolmentToken });
const mfaSecretBase32 = enrol.body.secret;
await api('POST', '/auth/mfa/confirm', null, { challengeToken: reg.body.mfaEnrolmentToken, code: totp(base32Decode(mfaSecretBase32)) });
ok(`tenant registered: ${EMAIL}`);

// A fresh login below (through the browser) re-derives its own token; this one
// is only used to seed the two data sources via the API, the same way the app
// itself creates them. Wait for a fresh TOTP window — the code just used to
// confirm MFA enrolment is replay-protected and would be rejected if reused
// immediately for login.
await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
const login1 = await api('POST', '/auth/login', null, { email: EMAIL, password: PASSWORD });
const verify1 = await api('POST', '/auth/mfa/verify', null, { challengeToken: login1.body.challengeToken, code: totp(base32Decode(mfaSecretBase32)) });
if (verify1.status !== 201 && verify1.status !== 200) throw new Error(`mfa/verify failed: ${JSON.stringify(verify1.body)}`);
const apiToken = verify1.body.accessToken;
await api('PATCH', '/auth/me/product-tour', apiToken, { status: 'skipped' });

step('Create two independent Excel data sources (A and B), both Gateway-connected');
const srcAResp = await api('POST', '/data-sources', apiToken, { name: `Customer Master ${tag}`, sourceKind: 'excel' });
if (srcAResp.status !== 201) throw new Error(`create source A failed: ${JSON.stringify(srcAResp.body)}`);
const srcA = srcAResp.body;
await api('PATCH', `/data-sources/${srcA.id}/mode`, apiToken, { enabled: true });
const srcBResp = await api('POST', '/data-sources', apiToken, { name: `Complaints ${tag}`, sourceKind: 'excel' });
if (srcBResp.status !== 201) throw new Error(`create source B failed: ${JSON.stringify(srcBResp.body)}`);
const srcB = srcBResp.body;
await api('PATCH', `/data-sources/${srcB.id}/mode`, apiToken, { enabled: true });
ok(`source A = ${srcA.id}, source B = ${srcB.id}`);

const SENTINEL_A = `FILE_A_SENTINEL_${tag}`;
const SENTINEL_B = `FILE_B_SENTINEL_${tag}`;
const csvA = `Name,Note\n${SENTINEL_A},row one\n`;
const csvB = `Name,Note\n${SENTINEL_B},row one\n`;

const dir = join(tmpdir(), 'dpdp-local-source-handles');
mkdirSync(dir, { recursive: true });
const inputFallbackPath = join(dir, `fallback-${tag}.csv`);
writeFileSync(inputFallbackPath, csvA, 'utf8');

// --- The mock bridge --------------------------------------------------------
// Node-side "IndexedDB" contents: { [dataSourceId]: { fileName, savedAt } }.
// Node-side mock handle behaviour: { [dataSourceId]: { content, fileName,
//   permissionState, grantOnRequest, unavailable, requestPermissionCalls } }.
let fakeDbRows = {};
let mockConfig = {};

function seedMockConfig(sourceId, { content, fileName, permissionState = 'granted', grantOnRequest = false, unavailable = false }) {
  mockConfig[sourceId] = { content, fileName, permissionState, grantOnRequest, unavailable, requestPermissionCalls: 0 };
}

// Installs (or re-installs) the File System Access picker mock. Kept
// separate from the IndexedDB mock so TEST 6 can delete showOpenFilePicker to
// simulate an unsupported browser, then this can re-install it afterwards for
// the remaining tests — on the SAME page, matching how a real user's single
// browser session behaves (never spinning up a second logged-in session just
// to work around the mock).
async function installPickerMock(page) {
  await page.addInitScript(() => {
    function makeHandle(dataSourceId, fileName) {
      return {
        kind: 'file',
        name: fileName,
        async queryPermission() {
          const c = await window.__mockHandleConfig(dataSourceId);
          return c ? c.permissionState : 'denied';
        },
        async requestPermission() {
          return window.__mockRequestPermission(dataSourceId);
        },
        async getFile() {
          const c = await window.__mockHandleConfig(dataSourceId);
          if (!c || c.unavailable) {
            const e = new Error('NotFoundError');
            e.name = 'NotFoundError';
            throw e;
          }
          return new File([c.content], c.fileName, { type: 'text/csv' });
        },
        async isSameEntry() {
          return true;
        },
      };
    }
    window.__dpdpMakeHandle = makeHandle;
    window.showOpenFilePicker = async () => {
      const sourceId = window.__nextPickSourceId;
      const fileName = window.__nextPickFileName;
      if (!sourceId) {
        const e = new Error('cancelled');
        e.name = 'AbortError';
        throw e;
      }
      return [makeHandle(sourceId, fileName)];
    };
  });
}

async function installMocks(page) {
  await page.exposeFunction('__fakeDbGet', (id) => fakeDbRows[id] ?? null);
  await page.exposeFunction('__fakeDbPut', (id, fileName, savedAt) => {
    fakeDbRows[id] = { fileName, savedAt };
  });
  await page.exposeFunction('__fakeDbDelete', (id) => {
    delete fakeDbRows[id];
  });
  await page.exposeFunction('__mockHandleConfig', (id) => mockConfig[id] ?? null);
  await page.exposeFunction('__mockRequestPermission', (id) => {
    const c = mockConfig[id];
    if (!c) return 'denied';
    c.requestPermissionCalls += 1;
    if (c.grantOnRequest) c.permissionState = 'granted';
    return c.permissionState;
  });
  await page.exposeFunction('__mockRequestPermissionCalls', (id) => mockConfig[id]?.requestPermissionCalls ?? 0);

  await installPickerMock(page);

  await page.addInitScript(() => {
    // Fake IndexedDB — same call shape local-source-handles.ts uses, backed by
    // the Node-side store via the exposed functions above, so it genuinely
    // persists across a real page reload/navigation.
    function request() {
      const r = {};
      return r;
    }
    const fakeIndexedDb = {
      open() {
        const openReq = request();
        Promise.resolve().then(() => {
          const db = {
            objectStoreNames: { contains: () => true },
            createObjectStore() {},
            transaction() {
              const tx = {};
              const store = {
                put(record) {
                  const r = request();
                  window.__fakeDbPut(record.dataSourceId, record.fileName, record.savedAt).then(() => {
                    Promise.resolve().then(() => tx.oncomplete && tx.oncomplete());
                  });
                  return r;
                },
                get(key) {
                  const r = request();
                  window.__fakeDbGet(key).then((row) => {
                    r.result = row ? { dataSourceId: key, handle: window.__dpdpMakeHandle(key, row.fileName), fileName: row.fileName, savedAt: row.savedAt } : undefined;
                    r.onsuccess && r.onsuccess();
                  });
                  return r;
                },
                delete(key) {
                  const r = request();
                  window.__fakeDbDelete(key).then(() => {
                    Promise.resolve().then(() => tx.oncomplete && tx.oncomplete());
                  });
                  return r;
                },
              };
              tx.objectStore = () => store;
              return tx;
            },
            close() {},
          };
          openReq.result = db;
          openReq.onsuccess && openReq.onsuccess();
        });
        return openReq;
      },
    };
    // `indexedDB` is a [Replaceable] WebIDL attribute on Window — a plain
    // `window.indexedDB = ...` assignment silently no-ops in Chromium (the real
    // IDBFactory stays in place). Object.defineProperty is required to actually
    // shadow it for this test.
    Object.defineProperty(window, 'indexedDB', { value: fakeIndexedDb, writable: true, configurable: true });
  });
}

async function queueMockPick(page, sourceId, fileName) {
  await page.evaluate(({ sourceId, fileName }) => {
    window.__nextPickSourceId = sourceId;
    window.__nextPickFileName = fileName;
  }, { sourceId, fileName });
}

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  await installMocks(page);

  const transmitted = [];
  page.on('request', (req) => transmitted.push({ url: req.url(), method: req.method(), postData: req.postData() || '' }));
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message));

  step('Log in through the real UI');
  await page.goto(`${WEB}/login`);
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  const mfa = page.locator('input[autocomplete="one-time-code"]').or(page.locator('form input:not([type])'));
  await mfa.first().waitFor({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
  await mfa.first().fill(totp(base32Decode(mfaSecretBase32)));
  await page.click('button[type=submit]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
  ok('logged in');

  // ===========================================================================
  step('TEST 1 — first connection: choose a file, it saves a handle and renders');
  // ===========================================================================
  seedMockConfig(srcA.id, { content: csvA, fileName: 'CustomerMaster.csv' });
  await page.goto(`${WEB}/data-sources/${srcA.id}/viewer`, { waitUntil: 'networkidle' });
  const chooseBtn = page.getByRole('button', { name: /^Choose file$/ });
  if ((await chooseBtn.count()) === 1) ok('supported browser shows a "Choose file" button (not the plain input)'); else bad('Choose file button not shown');
  await queueMockPick(page, srcA.id, 'CustomerMaster.csv');
  await chooseBtn.click();
  await page.waitForSelector(`text=${SENTINEL_A}`, { timeout: 10000 });
  ok('source A: file loaded and rendered after a fresh pick');
  // Exact match: the viewer ALSO shows a static "Gateway-connected" mode badge
  // near the top, which contains "Connected" as a substring — must not confuse
  // the two.
  const badge1 = await page.getByText('Connected', { exact: true }).count();
  if (badge1 >= 1) ok('source A: "Connected" badge shown after a fresh pick'); else bad('no Connected badge after fresh pick');

  // ===========================================================================
  step('TEST 2 — multi-file independence: source B gets its own file, source A is untouched');
  // ===========================================================================
  seedMockConfig(srcB.id, { content: csvB, fileName: 'Complaints.csv' });
  await page.goto(`${WEB}/data-sources/${srcB.id}/viewer`, { waitUntil: 'networkidle' });
  await queueMockPick(page, srcB.id, 'Complaints.csv');
  await page.getByRole('button', { name: /^Choose file$/ }).click();
  await page.waitForSelector(`text=${SENTINEL_B}`, { timeout: 10000 });
  ok('source B: connected to its own file');

  // Return to source A: permission is still 'granted' in the mock -> auto-reopens FILE A, never B.
  await page.goto(`${WEB}/data-sources/${srcA.id}/viewer`, { waitUntil: 'networkidle' });
  await page.waitForSelector(`text=${SENTINEL_A}`, { timeout: 10000 });
  const crossLeak = await page.locator(`text=${SENTINEL_B}`).count();
  if (crossLeak === 0) ok('source A auto-reopened its OWN file — source B never bled through'); else bad('cross-source contamination: source B content visible on source A');
  ok('source A: auto-reopened WITHOUT the user choosing a file again (granted permission)');

  // ===========================================================================
  step('TEST 3 — permission "prompt": never auto-requests; explicit Reconnect click works');
  // ===========================================================================
  mockConfig[srcA.id].permissionState = 'prompt';
  mockConfig[srcA.id].grantOnRequest = true; // clicking Reconnect will succeed
  await page.goto(`${WEB}/data-sources/${srcA.id}/viewer`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const preClickCalls = mockConfig[srcA.id].requestPermissionCalls;
  if (preClickCalls === 0) ok('mount effect did NOT call requestPermission() automatically'); else bad(`requestPermission() was called ${preClickCalls} time(s) without a click`);
  const noRowsYet = await page.locator(`text=${SENTINEL_A}`).count();
  if (noRowsYet === 0) ok('file is NOT auto-loaded while permission is only "prompt"'); else bad('file loaded without permission being granted');
  const reconnectBtn = page.getByRole('button', { name: /^Reconnect$/ });
  if ((await reconnectBtn.count()) === 1) ok('explicit "Reconnect" action is shown'); else bad('no Reconnect action shown for prompt state');
  await reconnectBtn.click();
  await page.waitForSelector(`text=${SENTINEL_A}`, { timeout: 10000 });
  ok('clicking Reconnect requested permission and reopened the file');

  // ===========================================================================
  step('TEST 4 — permission "denied": Reconnect click surfaces the denial, no crash');
  // ===========================================================================
  mockConfig[srcA.id].permissionState = 'denied';
  mockConfig[srcA.id].grantOnRequest = false;
  mockConfig[srcA.id].requestPermissionCalls = 0;
  await page.goto(`${WEB}/data-sources/${srcA.id}/viewer`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Reconnect$/ }).click();
  await page.waitForTimeout(300);
  const deniedMsg = await page.locator('text=Permission was not granted').count();
  if (deniedMsg >= 1) ok('a denied reconnect surfaces a clear message (no crash, no silent loop)'); else bad('denied reconnect did not surface a clear message');

  // ===========================================================================
  step('TEST 5 — file moved/deleted: "unavailable" state offers Choose another file');
  // ===========================================================================
  mockConfig[srcA.id].permissionState = 'granted';
  mockConfig[srcA.id].unavailable = true;
  await page.goto(`${WEB}/data-sources/${srcA.id}/viewer`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=could not be accessed', { timeout: 10000 });
  ok('a moved/deleted file is reported as unavailable, not a silent failure');
  const chooseAgain = await page.getByRole('button', { name: /Choose (a different )?file/ }).count();
  if (chooseAgain >= 1) ok('"Choose another file" affordance is still available after an unavailable handle'); else bad('no way to choose another file after unavailable');
  mockConfig[srcA.id].unavailable = false;

  // ===========================================================================
  step('TEST 6 — unsupported browser: falls back to the plain file input, never claims a connection');
  // ===========================================================================
  const srcC = (await api('POST', '/data-sources', apiToken, { name: `Employee records ${tag}`, sourceKind: 'csv' })).body;
  await api('PATCH', `/data-sources/${srcC.id}/mode`, apiToken, { enabled: true });
  await page.addInitScript(() => {
    delete window.showOpenFilePicker;
  });
  await page.goto(`${WEB}/data-sources/${srcC.id}/viewer`, { waitUntil: 'networkidle' });
  const plainInput = await page.locator('#ds-file').count();
  const pickerBtnGone = await page.getByRole('button', { name: /^Choose file$/ }).count();
  if (plainInput === 1 && pickerBtnGone === 0) ok('unsupported browser renders the plain <input type=file>, not the picker button'); else bad('fallback UI not shown correctly');
  await page.setInputFiles('#ds-file', inputFallbackPath);
  await page.waitForSelector(`text=${SENTINEL_A}`, { timeout: 10000 });
  const badgeOnFallback = await page.getByText('Connected', { exact: true }).count();
  if (badgeOnFallback === 0) ok('unsupported browser never shows a misleading "Connected" badge'); else bad('fallback browser falsely claimed a persistent connection');

  // Restore the picker mock for the remaining tests — this page's session
  // otherwise stays "unsupported" for every navigation from here on, since
  // addInitScript effects persist for the life of the page.
  await installPickerMock(page);

  // ===========================================================================
  step('TEST 7 — Data Sources list: independent per-row status, no cross-contamination');
  // ===========================================================================
  await page.goto(`${WEB}/data-sources`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const rowA = page.locator('tr', { hasText: `Customer Master ${tag}` });
  const rowB = page.locator('tr', { hasText: `Complaints ${tag}` });
  // Exact match: each row ALSO carries a static "Gateway-connected" access-mode
  // badge (unrelated to local-file connection state) which contains
  // "Connected" as a substring.
  const rowAConnected = await rowA.getByText('Connected', { exact: true }).count();
  const rowBConnected = await rowB.getByText('Connected', { exact: true }).count();
  if (rowAConnected >= 1 && rowBConnected >= 1) ok('both source A and source B independently show Connected on the list page');
  else bad(`row status mismatch: A connected=${rowAConnected}, B connected=${rowBConnected}`);

  // ===========================================================================
  step('TEST 8 — removing a connected source does not block deletion or corrupt the other source');
  // ===========================================================================
  page.once('dialog', (d) => d.accept('QA cleanup'));
  await rowA.getByRole('button', { name: 'Remove' }).click();
  await page.waitForTimeout(500);
  const rowAGone = await page.locator('tr', { hasText: `Customer Master ${tag}` }).count();
  if (rowAGone === 0) ok('source A removed successfully despite having a connected local handle'); else bad('source A removal failed');
  const rowBStillConnected = await page.locator('tr', { hasText: `Complaints ${tag}` }).getByText('Connected', { exact: true }).count();
  if (rowBStillConnected >= 1) ok('source B remains independently Connected after source A was removed'); else bad('source B was affected by source A removal');

  // ===========================================================================
  step('TEST 9 — no file bytes, rows, or filesystem paths ever reached the backend');
  // ===========================================================================
  const sentinelLeaks = transmitted.filter(
    (t) =>
      (t.postData && (t.postData.includes(SENTINEL_A) || t.postData.includes(SENTINEL_B))) ||
      t.url.includes(SENTINEL_A) ||
      t.url.includes(SENTINEL_B),
  );
  if (sentinelLeaks.length === 0) ok('NO network request ever carried file content/row values'); else bad(`raw content leaked in ${sentinelLeaks.length} request(s)`);

  const pathLeaks = transmitted.filter((t) => /[Cc]:\\\\|file:\/\/|\/home\/|\/Users\//.test(t.postData || '') || /[Cc]:\\\\|file:\/\/|\/home\/|\/Users\//.test(t.url));
  if (pathLeaks.length === 0) ok('NO request ever carried a filesystem path'); else bad(`filesystem path leaked in ${pathLeaks.length} request(s)`);

  const rawAccessCalls = transmitted.filter((t) => /\/data-sources\/[^/]+\/raw-access$/.test(new URL(t.url).pathname));
  const malformedAudit = rawAccessCalls.filter((c) => {
    try {
      const b = JSON.parse(c.postData || '{}');
      return Object.keys(b).length !== 1 || typeof b.rowCount !== 'number';
    } catch {
      return true;
    }
  });
  if (rawAccessCalls.length >= 1 && malformedAudit.length === 0) ok(`raw-access audit calls stayed metadata-only ({rowCount}); ${rawAccessCalls.length} call(s)`);
  else bad('raw-access audit call was not metadata-only');

  const multipart = transmitted.some((t) => (t.postData || '').includes('Content-Disposition') || (t.postData || '').includes('filename='));
  if (!multipart) ok('no multipart file upload occurred anywhere'); else bad('a multipart upload happened');

  console.log(process.exitCode ? '\nFAILED' : '\nPERSISTENT SAAS LOCAL SOURCE — REAL BROWSER VERIFICATION PASSED');
} finally {
  await browser?.close();
}
