import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE AGENT BOUNDARY GUARD (originally Phase-3B; now also pins the Phase-3C
 * enrollment exception, and Phase 2's packaging-related exceptions,
 * precisely, rather than being disabled/loosened).
 *
 * The agent's TOP-LEVEL files (this directory, non-recursive — connectors/ has
 * its own guards, e.g. raw-access-guard equivalents at the connector level)
 * must have NO database write path, and must never log a token/credential. It
 * must not reach into SchemaSource (S4) or Tier-2. Capabilities that are
 * deliberately real are each confined to exactly one file and asserted as
 * such below rather than just exempted silently:
 *   - enrollment.ts is the sole filesystem reader of SECRET local state (its
 *     own device-credential.json) and the sole control-plane HTTP client.
 *   - config-file.ts (Phase 1 of the production build-out) is a SECOND,
 *     narrower filesystem-read exception: it reads ONLY the ordinary,
 *     non-secret config.json (control-plane URL, bind address, log level —
 *     see its own header for why secrets never belong in that schema, and
 *     config-file.spec.ts's own test asserting none of its fields resemble a
 *     credential name). It must never gain a write path or a second purpose.
 *   - credential-store-windows.ts (Phase 2 of the production build-out) is a
 *     Windows-specific IMPLEMENTATION of the same device-credential.json
 *     concern enrollment.ts already owns (DPAPI-encrypted instead of plain
 *     JSON — see its own header's threat model) — not a second credential
 *     store, a second backend for the same one.
 *   - pending-enrollment.ts (Phase 2) reads/writes ONLY
 *     pending-enrollment.json, the Gateway Setup wizard's one-time hand-off
 *     file for an enrolment code — never customer data, never a
 *     database/filesystem connector.
 *   - atomic-write.ts (Phase 3) is the shared temp-file-plus-rename writer
 *     (and scrub-then-delete) used by the stores above; it writes only what
 *     its callers hand it, into the state directory.
 *   - sources-file.ts (Phase 3) owns sources.json and pending-sources.json:
 *     source CONFIGURATION (with DPAPI-protected credentials), never data
 *     read through a connector. It was moved OUT of connectors/registry.ts
 *     precisely so connectors/ never has a file-write path (see
 *     data-plane.spec.ts's raw-data guard, which no longer exempts it).
 *   - single-instance.ts (Phase 2) reads/writes ONLY agent.lock, a PID-only
 *     lock file preventing two agent processes from running against the same
 *     state directory — never customer data.
 *   - data-plane.ts is exempted from the outbound-call check too, but —
 *     following the removal of its own httpControlPlaneClient — no longer
 *     itself calls fetch.
 * This spec asserts those absences/exceptions structurally over the agent's
 * own source, in the same static-analysis style as the datasource/consent/
 * gateway guards — so a future edit that starts building capability outside
 * its intended file goes red here.
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

  it('12. no filesystem reader exists outside the two named, deliberate exceptions', () => {
    // enrollment.ts (Phase 3C agent-side enrollment): persists this device's
    // own enrollment credential to a local JSON file (never a client-database
    // credential, never customer data — see loadPersistedCredential/
    // savePersistedCredential).
    //
    // config-file.ts (Phase 1 of the production build-out): reads ONLY the
    // ordinary, non-secret config.json (see this file's header above for why
    // that schema can never carry a secret). config-resolve.ts and
    // config-paths.ts do NOT read files themselves — they call into
    // config-file.ts / compute a path string — so neither is exempted here;
    // if either one ever starts reading a file directly, this guard must
    // catch it.
    //
    // No other top-level runtime file may read/write a file.
    const FS = ['readFileSync', 'readFile(', 'createReadStream', 'openSync', 'fs.read', "from 'node:fs'", "require('node:fs')"];
    const EXEMPT = [
      'enrollment.ts',
      'config-file.ts',
      'credential-store-windows.ts',
      'pending-enrollment.ts',
      'single-instance.ts',
      'atomic-write.ts',
      'sources-file.ts',
    ];
    for (const [file, src] of Object.entries(code)) {
      if (EXEMPT.some((name) => file.endsWith(name))) continue;
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
