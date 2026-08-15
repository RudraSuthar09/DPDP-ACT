import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PHASE-2 RAW-DATA BOUNDARY GUARD.
 *
 * Phase 2 proves that a customer's Excel/CSV data can be viewed inside DPDP
 * Shield WITHOUT the raw values ever reaching the central backend, PostgreSQL,
 * logs, telemetry, or any browser persistence. That invariant lives in the
 * frontend raw-data viewer + its local parser. This spec statically asserts the
 * dangerous escape hatches are simply absent from those files, in the same
 * static-analysis style as schema-source.spec / raw-access-guard.spec — so if a
 * future edit adds one, the PR fails here.
 *
 * (This runs in the backend jest suite because that is the project's test
 * runner; it only reads the frontend source files, it does not import them.)
 */

// backend/src/modules/datasource -> up 4 -> repo root (DPDP-ACT).
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const VIEWER = join(REPO_ROOT, 'frontend', 'src', 'app', '(app)', 'data-sources', '[id]', 'viewer', 'page.tsx');
const PARSER = join(REPO_ROOT, 'frontend', 'src', 'lib', 'local-file.ts');
const MASK = join(REPO_ROOT, 'frontend', 'src', 'lib', 'pii-mask.ts');
// The Phase-3D Gateway browser reads rows FROM the local Gateway (a configurable
// address) — it must be held to the same no-persistence/no-telemetry boundary.
const GATEWAY_PAGE = join(REPO_ROOT, 'frontend', 'src', 'app', '(app)', 'data-sources', '[id]', 'gateway', 'page.tsx');
const RAW_DATA_FILES = [VIEWER, PARSER, MASK, GATEWAY_PAGE];

/** Strip comments so the guard checks CODE, not the prose that explains it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// Browser persistence + non-metadata transport + telemetry — none may appear in
// the raw-data files.
const FORBIDDEN = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'openDatabase',
  'caches.',
  'FormData',
  'XMLHttpRequest',
  'WebSocket',
  'sendBeacon',
  'axios',
  'gtag',
  'dataLayer',
  'Sentry',
  'captureException',
  'analytics',
  'console.log',
  'console.error',
  'console.debug',
  'console.info',
  'console.warn',
];

describe('Phase 2 — raw customer data never leaves the browser', () => {
  it('the raw-data files exist (guard is not vacuous)', () => {
    for (const f of RAW_DATA_FILES) expect(existsSync(f)).toBe(true);
  });

  it.each(RAW_DATA_FILES.map((f) => [f.replace(REPO_ROOT, ''), f]))(
    'no persistence/telemetry/alt-transport escape hatch in %s',
    (_label, file) => {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const forbidden of FORBIDDEN) {
        if (code.includes(forbidden)) {
          throw new Error(
            [
              '',
              '='.repeat(74),
              `  PHASE-2 BOUNDARY VIOLATION: "${forbidden}" in ${file.replace(REPO_ROOT, '')}`,
              '',
              '  Raw customer data must stay in the browser tab only — never in',
              '  localStorage/sessionStorage/IndexedDB/Cache, never posted via',
              '  FormData/XHR/WebSocket/beacon, never sent to telemetry, never logged.',
              '='.repeat(74),
              '',
            ].join('\n'),
          );
        }
      }
    },
  );

  it('the local parser makes NO network call at all (pure in-browser parsing)', () => {
    const parser = codeOnly(readFileSync(PARSER, 'utf8'));
    for (const net of ['fetch(', 'apiFetch', 'XMLHttpRequest', 'WebSocket', 'axios', 'sendBeacon']) {
      expect(parser.includes(net)).toBe(false);
    }
  });

  it("the viewer's ONLY backend call is the metadata-only raw-access audit (row count, never rows)", () => {
    const viewer = codeOnly(readFileSync(VIEWER, 'utf8'));
    // It calls the metadata endpoint...
    expect(viewer).toContain('/raw-access');
    expect(viewer).toContain('rowCount');
    // ...and never posts the file/rows/parsed data under any of these names.
    for (const bad of ['body: { rows', 'body: { file', 'body: { data', 'FormData', 'arrayBuffer(', 'result.rows }']) {
      expect(viewer.includes(bad)).toBe(false);
    }
  });
});
