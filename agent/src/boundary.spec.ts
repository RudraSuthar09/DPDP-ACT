import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE AGENT BOUNDARY GUARD (originally Phase-3B; now also pins the Phase-3C
 * enrollment exception precisely, rather than being disabled/loosened).
 *
 * The agent's TOP-LEVEL files (this directory, non-recursive — connectors/ has
 * its own guards, e.g. raw-access-guard equivalents at the connector level)
 * must have NO database write path, and must never log a token/credential. It
 * must not reach into SchemaSource (S4) or Tier-2. Two capabilities are now
 * deliberately real, each confined to exactly one file and asserted as such
 * below rather than just exempted silently: enrollment.ts is the sole
 * filesystem reader (its own local credential file) and the sole
 * control-plane HTTP client; data-plane.ts is exempted from the outbound-call
 * check too, but — following the removal of its own httpControlPlaneClient —
 * no longer itself calls fetch. This spec asserts those absences/exceptions
 * structurally over the agent's own source, in the same static-analysis style
 * as the datasource/consent/gateway guards — so a future edit that starts
 * building capability outside its intended file goes red here.
 */

const SRC_DIR = __dirname;

function runtimeFiles(): string[] {
  return readdirSync(SRC_DIR)
    .map((n) => join(SRC_DIR, n))
    .filter((f) => statSync(f).isFile() && f.endsWith('.ts') && !f.endsWith('.spec.ts'));
}

/** Strip comments so the guard checks CODE, not the prose explaining it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const files = runtimeFiles();
const code = Object.fromEntries(files.map((f) => [f, codeOnly(readFileSync(f, 'utf8'))] as const));

describe('Phase 3B — the agent skeleton has no data capability (boundary guard)', () => {
  it('has runtime source to check (not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5); // version, config, origin, auth, health, server, index
  });

  it('10/11. no raw-read, connector, or customer-data capability exists', () => {
    const FORBIDDEN = [
      // raw reads
      'readRows', 'getRows', 'fetchRows', 'sampleRows', 'readData', 'fetchData',
      'getValues', 'readValues', 'dumpTable', 'customerData', 'rowData',
      // connectors / parsers
      'implements DataConnector', 'xlsx', 'exceljs', 'csv-parse', 'sheet_to_json',
      // browser persistence (not applicable, but pin it anyway)
      'localStorage', 'sessionStorage', 'indexedDB',
    ];
    for (const [file, src] of Object.entries(code)) {
      for (const forbidden of FORBIDDEN) {
        expect({ file, forbidden, hit: src.includes(forbidden) }).toEqual({ file, forbidden, hit: false });
      }
    }
  });

  it('10. no database / persistence write path exists', () => {
    const DB = ["from 'pg'", 'require(\'pg\')', 'new Pool', '.query(', 'INSERT ', 'UPDATE ', 'DELETE FROM', 'pg-boss', 'Repository', 'apply_tenant_rls', 'node-pg-migrate'];
    for (const [file, src] of Object.entries(code)) {
      for (const token of DB) {
        expect({ file, token, hit: src.includes(token) }).toEqual({ file, token, hit: false });
      }
    }
  });

  it('12. no filesystem reader exists outside the one deliberate exception (enrollment.ts)', () => {
    // enrollment.ts (Phase 3C agent-side enrollment) is the ONE deliberate
    // exception: it persists this device's own enrollment credential to a
    // local JSON file (never a client-database credential, never customer
    // data — see loadPersistedCredential/savePersistedCredential). No other
    // top-level runtime file may read/write a file.
    const FS = ['readFileSync', 'readFile(', 'createReadStream', 'openSync', 'fs.read', "from 'node:fs'", "require('node:fs')"];
    for (const [file, src] of Object.entries(code)) {
      if (file.endsWith('enrollment.ts')) continue;
      for (const token of FS) {
        expect({ file, token, hit: src.includes(token) }).toEqual({ file, token, hit: false });
      }
    }
  });

  it('the only outbound calls are the control-plane client (enrollment.ts) and its data-plane use (data-plane.ts)', () => {
    // enrollment.ts is the ONE control-plane HTTP client (enroll, heartbeat,
    // session refresh, de-enroll, pairing redemption) — see
    // createControlPlaneClient. It carries metadata only: ids, hashes,
    // tokens, non-secret device info, never a client-database credential or
    // a customer value (enforced server-side too, by gateway.dto.ts's
    // rejectSecretFields). data-plane.ts is exempted too (harmless even
    // though it no longer itself calls fetch — it depends on the injected
    // ControlPlaneClient interface, never a second HTTP implementation of
    // its own). NO other top-level runtime file may make a network call.
    const OUT = ['http.request', 'https.request', 'fetch(', 'axios', 'new WebSocket', 'sendBeacon'];
    for (const [file, src] of Object.entries(code)) {
      if (file.endsWith('data-plane.ts') || file.endsWith('enrollment.ts')) continue;
      for (const token of OUT) {
        expect({ file, token, hit: src.includes(token) }).toEqual({ file, token, hit: false });
      }
    }
  });

  it('12/13. the agent does not reach into SchemaSource (S4) or Tier-2', () => {
    for (const [file, src] of Object.entries(code)) {
      for (const token of ['SchemaSource', 'readRows', 'fulfilment', 'Fulfilment', 'dpr_fulfilments']) {
        expect({ file, token, hit: src.includes(token) }).toEqual({ file, token, hit: false });
      }
    }
  });

  it('14. tokens/secrets are never written to logs', () => {
    // No logging statement may reference the auth header, a token, credentials,
    // or the raw request headers. Scan comment-stripped lines.
    for (const [file, src] of Object.entries(code)) {
      for (const line of src.split('\n')) {
        const isLog = /\b(console|log)\s*[.(]/.test(line);
        if (!isLog) continue;
        for (const banned of ['token', 'authorization', 'req.headers', 'GATEWAY_AUTH_HEADER', 'secret', 'password', 'origin]']) {
          expect({ file, line: line.trim(), banned, hit: line.toLowerCase().includes(banned.toLowerCase()) }).toEqual({
            file,
            line: line.trim(),
            banned,
            hit: false,
          });
        }
      }
    }
  });

  it('10 (origins). no hard-coded origin exists in the origin-authorization logic', () => {
    // Check CODE, not the doc comments that name example origins to explain them.
    const origin = codeOnly(readFileSync(join(SRC_DIR, 'origin.ts'), 'utf8'));
    expect(origin).not.toContain('http://');
    expect(origin).not.toContain('https://');
    expect(origin).not.toContain('localhost');
    expect(origin).not.toContain('127.0.0.1');
    // And config sources the allowlist from the environment variable.
    const config = codeOnly(readFileSync(join(SRC_DIR, 'config.ts'), 'utf8'));
    expect(config).toContain('GATEWAY_ALLOWED_ORIGINS');
    expect(config).not.toContain('http://localhost');
    expect(config).not.toContain('192.168');
  });
});
