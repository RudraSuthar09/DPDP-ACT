import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PHASE-3C GATEWAY SECURITY GUARD.
 *
 * Phase 3C builds the control plane (enrol/pair/session/heartbeat/revoke). This
 * guard pins what the control plane must NEVER become, structurally, so a future
 * edit that crosses the line fails in the PR:
 *
 *   - no raw-data / data-plane route on the central API (I1);
 *   - no raw-read identifier, no file/DB CONNECTOR library in this module;
 *   - the migration stores NO private key / device secret (public key only);
 *   - no token / secret / code / nonce / customer value is ever logged;
 *   - audit annotations are metadata only (no code/nonce/token/public-key value);
 *   - the module does not reach into SchemaSource (S4) or Tier-2.
 */

const MODULE_DIR = __dirname;
const SRC_DIR = join(__dirname, '..', '..');
const MIGRATION = join(SRC_DIR, '..', 'migrations', '1737003200000_gateway-control-plane.sql');

function moduleRuntimeFiles(): string[] {
  return readdirSync(MODULE_DIR)
    .map((n) => join(MODULE_DIR, n))
    .filter((f) => statSync(f).isFile() && f.endsWith('.ts') && !f.endsWith('.spec.ts'));
}

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
function sqlCodeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const files = moduleRuntimeFiles();
const code = Object.fromEntries(files.map((f) => [f, codeOnly(readFileSync(f, 'utf8'))] as const));

describe('Phase 3C — the Gateway control plane has no raw-data capability', () => {
  it('has runtime files to check (not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('the controller declares only control-plane routes — no data-plane/raw route', () => {
    const controller = readFileSync(join(MODULE_DIR, 'gateway.controller.ts'), 'utf8');
    const routes = Array.from(controller.matchAll(/@(?:Get|Post|Put|Patch|Delete)\(\s*'([^']*)'/g)).map((m) => m[1] ?? '');
    expect(routes.length).toBeGreaterThan(4); // there ARE routes
    for (const route of routes) {
      for (const forbidden of ['source/read', 'source/discover', 'source/search', 'session/establish', 'rows', 'data', 'dump', 'read', 'values', 'records']) {
        expect({ route, forbidden, hit: route.includes(forbidden) }).toEqual({ route, forbidden, hit: false });
      }
    }
  });

  it('no raw-read identifier and no file/DB connector library appears in the module', () => {
    const FORBIDDEN = [
      'readRows', 'getRows', 'fetchRows', 'sampleRows', 'readData', 'fetchData', 'getValues', 'dumpTable', 'customerData', 'rowData',
      'xlsx', 'exceljs', 'csv-parse', 'sheet_to_json', 'mysql', 'mssql', 'tedious', 'mongodb', 'oracledb',
    ];
    for (const [file, src] of Object.entries(code)) {
      for (const forbidden of FORBIDDEN) {
        expect({ file, forbidden, hit: src.includes(forbidden) }).toEqual({ file, forbidden, hit: false });
      }
    }
  });

  it('the migration stores a PUBLIC key and no private key / device secret', () => {
    const sql = sqlCodeOnly(readFileSync(MIGRATION, 'utf8'));
    expect(sql).toContain('public_key');
    for (const forbidden of ['private_key', 'privatekey', 'secret_key', 'device_secret']) {
      expect({ forbidden, hit: sql.includes(forbidden) }).toEqual({ forbidden, hit: false });
    }
  });

  it('no token / secret / code / nonce / customer value is ever logged', () => {
    for (const [file, src] of Object.entries(code)) {
      for (const line of src.split('\n')) {
        if (!/\bconsole\s*\./.test(line)) continue;
        for (const banned of ['token', 'secret', 'code', 'nonce', 'publickey', 'password', 'private', 'req.headers']) {
          expect({ file, line: line.trim(), banned, hit: line.toLowerCase().includes(banned) }).toEqual({
            file,
            line: line.trim(),
            banned,
            hit: false,
          });
        }
      }
    }
  });

  it('every audit annotation is metadata only (no code/nonce/token/public-key value)', () => {
    const service = codeOnly(readFileSync(join(MODULE_DIR, 'gateway.service.ts'), 'utf8'));
    // Extract each annotate({ ... }) argument block and check its field names.
    const blocks = service.split('this.audit.annotate(').slice(1).map((chunk) => chunk.split('});')[0] ?? '');
    expect(blocks.length).toBeGreaterThan(3);
    for (const block of blocks) {
      // Ban VALUE leakage — interpolated secret variables and hash/value field
      // names — not the descriptive words in a reason string.
      for (const banned of ['${nonce}', '${code}', '${next}', '${sessionToken}', '${token}', 'publicKey', 'privateKey', 'codeHash', 'tokenHash', 'nonceHash', 'password']) {
        expect({ banned, hit: block.includes(banned) }).toEqual({ banned, hit: false });
      }
    }
  });

  it('the module does not reach into SchemaSource (S4) or Tier-2', () => {
    for (const [file, src] of Object.entries(code)) {
      for (const token of ['SchemaSource', 'readRows', 'fulfilment', 'Fulfilment', 'dpr_fulfilments']) {
        expect({ file, token, hit: src.includes(token) }).toEqual({ file, token, hit: false });
      }
    }
  });
});
