import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PHASE-3G-2.5 GUARD.
 *
 * The persistent Gateway endpoint must remain what it is: NON-SECRET
 * configuration metadata, never hardcoded, never a substitute for the
 * existing device/session security model, and never the ONLY copy (the
 * central database must be the source of truth, browser state a cache).
 *
 *   - no hardcoded IP/hostname/port literal anywhere in the backend gateway
 *     module (the endpoint must always come from client input / the DB row);
 *   - no credential-shaped field anywhere near the endpoint code;
 *   - the new migration adds ONLY a plain, non-secret column + an index —
 *     no private key, no secret, no customer-value-shaped column;
 *   - the frontend Gateway panel loads its state from the CENTRAL API (not
 *     only localStorage/sessionStorage), and every reachability probe is
 *     wrapped so a Gateway/network failure can never throw uncaught (the
 *     white-screen failure mode this phase exists to prevent).
 */

const MODULE_DIR = __dirname;
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const MIGRATION = join(REPO_ROOT, 'backend', 'migrations', '1737003400000_gateway-device-endpoint.sql');
const GATEWAY_CONNECTION_LIB = join(REPO_ROOT, 'frontend', 'src', 'lib', 'gateway-connection.ts');
const DATA_SOURCES_PAGE = join(REPO_ROOT, 'frontend', 'src', 'app', '(app)', 'data-sources', 'page.tsx');

const BACKEND_FILES = ['gateway.dto.ts', 'gateway.service.ts', 'gateway.controller.ts', 'gateway.repository.ts'].map(
  (f) => join(MODULE_DIR, f),
);

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
function sqlCodeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

describe('Phase 3G-2.5 — the Gateway endpoint is non-secret, non-hardcoded, DB-backed config', () => {
  it('checks real files (not vacuous)', () => {
    for (const f of [...BACKEND_FILES, MIGRATION, GATEWAY_CONNECTION_LIB, DATA_SOURCES_PAGE]) {
      expect(() => readFileSync(f, 'utf8')).not.toThrow();
    }
  });

  it('no hardcoded IP/localhost/port literal anywhere in the backend gateway module', () => {
    for (const f of BACKEND_FILES) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const forbidden of ['127.0.0.1', 'localhost', '192.168.', '10.0.0.', '172.16.', ':7071', ':3001']) {
        expect({ f, forbidden, hit: code.includes(forbidden) }).toEqual({ f, forbidden, hit: false });
      }
    }
  });

  it('no hardcoded network literal in the frontend Gateway files (placeholders only, never a default value used)', () => {
    for (const f of [GATEWAY_CONNECTION_LIB]) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const forbidden of ['127.0.0.1', 'localhost:', '192.168.']) {
        expect({ f, forbidden, hit: code.includes(forbidden) }).toEqual({ f, forbidden, hit: false });
      }
    }
  });

  it('the endpoint column/DTO/service carry no credential-shaped field', () => {
    for (const f of BACKEND_FILES) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const forbidden of ['password', 'privateKey', 'private_key', 'secretKey', 'connectionString', 'dsn']) {
        // The shared FORBIDDEN_SECRET_FIELDS list itself legitimately names
        // these strings (as literal strings to reject) — that is fine; what
        // must never exist is a field/column DECLARATION using one of them.
        const declared = new RegExp(`\\b${forbidden}\\s*[:=]`, 'i');
        expect({ f, forbidden, hit: declared.test(code) }).toEqual({ f, forbidden, hit: false });
      }
    }
  });

  it('the migration adds only a plain non-secret column + index — no private key, no value column', () => {
    const sql = sqlCodeOnly(readFileSync(MIGRATION, 'utf8'));
    expect(sql).toContain('ADD COLUMN endpoint');
    expect(sql).toContain('UNIQUE INDEX');
    // Column/identifier-shaped forbidden names — not the bare word "secret",
    // which legitimately appears in this migration's own explanatory prose
    // ("non-secret"), same as every other Gateway/data-source migration.
    for (const forbidden of ['private_key', 'password', 'secret_key', 'customer_value', 'row_value', 'field_value']) {
      expect(sql.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('the frontend panel loads Gateway state from the CENTRAL API, not only browser storage', () => {
    const page = codeOnly(readFileSync(DATA_SOURCES_PAGE, 'utf8'));
    expect(page).toContain('/gateway/devices/active');
    for (const bad of ['localStorage', 'sessionStorage']) {
      expect(page.includes(bad)).toBe(false);
    }
  });

  it('the health probe never throws uncaught — every fetch is wrapped, and network failure classifies as offline, not a crash', () => {
    const lib = codeOnly(readFileSync(GATEWAY_CONNECTION_LIB, 'utf8'));
    expect(lib).toContain('try {');
    expect(lib).toContain('catch');
    expect(lib).toContain('reached: false');
    // The probe function itself is declared async and never documented/typed
    // to throw — its catch swallows and returns a classifiable result instead.
    expect(lib).toMatch(/export async function probeGatewayHealth/);
  });

  it('the endpoint value used for the probe comes from application state, never a literal', () => {
    const page = codeOnly(readFileSync(DATA_SOURCES_PAGE, 'utf8'));
    // probeGatewayHealth is always called with a variable (current.endpoint /
    // device.endpoint), never a string literal.
    const calls = Array.from(page.matchAll(/probeGatewayHealth\(([^)]*)\)/g)).map((m) => (m[1] ?? '').trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const arg of calls) {
      expect(arg.startsWith("'") || arg.startsWith('"')).toBe(false);
    }
  });
});
