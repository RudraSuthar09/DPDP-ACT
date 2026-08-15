import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATEWAY_ALLOWED_ORIGINS,
  GATEWAY_AUDIT_ACTIONS,
  GATEWAY_ERROR_CODES,
  GATEWAY_LOG_FIELDS,
  GATEWAY_PATH_RESOLUTION_STEPS,
  GATEWAY_CONTROL_ROUTES,
  GATEWAY_DATA_ROUTES,
  RESOURCE_KINDS,
} from '@dpdp/shared';

/**
 * THE PHASE-3A CONTRACT GUARD (I1 / Gateway Mode-B).
 *
 * Phase 3A adds the Gateway SECURITY CONTRACT — shapes, names, scopes, TTLs — but
 * NONE of the enforcement. These guards make the contract's own promises checkable
 * so a future edit cannot quietly weaken them, in the same static-analysis style as
 * schema-source.spec / event-sink-write-path.spec / raw-access-guard.spec:
 *
 *   - control-plane DTOs never carry a raw-data field;
 *   - the session token / nonce types never carry a customer value;
 *   - the Origin allowlist is exact (no wildcard, no loose matching);
 *   - the connector interface is SEPARATE from SchemaSource, which stays row-free;
 *   - the audit + agent-log schemas are metadata-only;
 *   - the filesystem resolver contract names every required step.
 *
 * These are ARCHITECTURE guards, not a fake implementation. Nothing here runs the
 * Gateway; the file under test is a pure type/const contract in shared/src.
 */

// backend/src/modules/gateway -> up 4 -> repo root (DPDP-ACT).
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const GATEWAY_CONTRACT = join(REPO_ROOT, 'shared', 'src', 'gateway.ts');
const SEAMS = join(REPO_ROOT, 'shared', 'src', 'seams.ts');

/** Strip comments so the guard checks the CODE (the actual type/const shapes),
 *  not the prose that names forbidden things in order to forbid them. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Extract the body of a named `export interface X { ... }` block (code only),
 *  so we can assert field names ON A SPECIFIC TYPE rather than file-wide. */
function interfaceBody(code: string, name: string): string {
  const start = code.indexOf(`interface ${name}`);
  if (start === -1) return '';
  const open = code.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return '';
}

const RAW_DATA_FIELD_NAMES = [
  'rows',
  'data',
  'file',
  'content',
  'values',
  'cells',
  'fileName',
  'filename',
  'payload',
  'records',
  'rawValue',
  'body',
];

describe('Phase 3A — the Gateway contract is present and non-vacuous', () => {
  const code = codeOnly(readFileSync(GATEWAY_CONTRACT, 'utf8'));

  it('the contract file exists and defines its key exports', () => {
    expect(code.length).toBeGreaterThan(2000);
    for (const marker of [
      'GATEWAY_LOOPBACK_HOST',
      'PairingNonceRecord',
      'GatewaySession',
      'DeviceEnrollmentRequest',
      'DataConnector',
      'GATEWAY_ERROR_CODES',
      'GatewayAuditMetadata',
      'ResourceHandle',
      'ResourceDescriptor',
    ]) {
      expect(code).toContain(marker);
    }
  });

  it('the enumerations are populated (the constants are real, not empty)', () => {
    expect(GATEWAY_ALLOWED_ORIGINS.length).toBeGreaterThan(0);
    expect(GATEWAY_ERROR_CODES.length).toBeGreaterThan(5);
    expect(GATEWAY_AUDIT_ACTIONS.length).toBeGreaterThan(0);
    expect(GATEWAY_LOG_FIELDS.length).toBeGreaterThan(0);
    expect(GATEWAY_PATH_RESOLUTION_STEPS.length).toBe(4);
  });
});

describe('Phase 3A — Guard 1/2: control-plane DTOs carry NO raw-data field', () => {
  const code = codeOnly(readFileSync(GATEWAY_CONTRACT, 'utf8'));

  // Every control-plane (Agent↔Azure) request/response type. None may carry data.
  const CONTROL_TYPES = [
    'DeviceEnrollmentRequest',
    'DeviceIdentity',
    'PairingNonceRecord',
    'GatewaySession',
    'GatewayEnrollRequest',
    'GatewayEnrollResponse',
    'GatewayHeartbeatRequest',
    'GatewayHeartbeatResponse',
    'GatewayPairRedeemRequest',
    'GatewayPairRedeemResponse',
    'GatewaySessionRefreshRequest',
    'GatewaySessionRefreshResponse',
    'GatewayDeenrollRequest',
    'GatewayRevokeRequest',
    'GatewayAuditMetadata',
  ];

  it.each(CONTROL_TYPES)('control DTO %s has no raw-data-shaped field', (typeName) => {
    const body = interfaceBody(code, typeName);
    expect(body.length).toBeGreaterThan(0); // the type actually exists
    // Field-name check: split declared fields and compare the KEY, so that a
    // legitimate substring in a comment or a nested type name can't false-trip,
    // and so `boundSourceIds` etc. don't match on "data".
    const fieldKeys = Array.from(body.matchAll(/(^|\n)\s*([a-zA-Z0-9_]+)\??\s*:/g)).map(
      (m) => (m[2] ?? '').toLowerCase(),
    );
    for (const forbidden of RAW_DATA_FIELD_NAMES) {
      expect(fieldKeys).not.toContain(forbidden.toLowerCase());
    }
  });

  it('the ONLY type in the file that carries `rows` is the DATA-PLANE read response', () => {
    // rows are legitimate on exactly one type — the browser↔agent read response —
    // and must not appear on any control DTO. Assert that boundary explicitly.
    const readBody = interfaceBody(code, 'GatewaySourceReadResponse');
    expect(readBody).toContain('rows');
    for (const typeName of CONTROL_TYPES) {
      expect(interfaceBody(code, typeName)).not.toContain('rows:');
    }
  });
});

describe('Phase 3A — Guard 7: session token + nonce carry no customer data', () => {
  const code = codeOnly(readFileSync(GATEWAY_CONTRACT, 'utf8'));

  it.each(['GatewaySession', 'PairingNonceRecord'])(
    '%s exposes only opaque/id/timestamp fields — no customer value fields',
    (typeName) => {
      const body = interfaceBody(code, typeName);
      const fieldKeys = Array.from(body.matchAll(/(^|\n)\s*([a-zA-Z0-9_]+)\??\s*:/g)).map(
        (m) => (m[2] ?? '').toLowerCase(),
      );
      for (const pii of ['aadhaar', 'pan', 'name', 'email', 'phone', 'address', 'dob', 'value', 'values']) {
        expect(fieldKeys).not.toContain(pii);
      }
    },
  );
});

describe('Phase 3A — Guard 9: Origin allowlist is exact (no wildcard/loose match)', () => {
  const code = codeOnly(readFileSync(GATEWAY_CONTRACT, 'utf8'));

  it('no wildcard appears in the allowed-origins list', () => {
    for (const origin of GATEWAY_ALLOWED_ORIGINS) {
      expect(origin).not.toContain('*');
    }
  });

  it('every allowed origin is a fully-qualified exact origin (scheme://host[:port])', () => {
    for (const origin of GATEWAY_ALLOWED_ORIGINS) {
      expect(origin).toMatch(/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i);
    }
  });

  it('the contract does not offer a substring/startsWith/includes origin matcher', () => {
    // The contract must not ship a loose-matching helper that a future
    // implementation could lean on. There are no functions in this file at all.
    expect(code).not.toMatch(/\.startsWith\(/);
    expect(code).not.toMatch(/\.includes\(\s*origin/i);
    expect(code).not.toMatch(/origin\s*=>/i);
  });
});

describe('Phase 3A — Guard 3/4: DataConnector is separate; SchemaSource stays row-free', () => {
  const gateway = codeOnly(readFileSync(GATEWAY_CONTRACT, 'utf8'));
  const seams = codeOnly(readFileSync(SEAMS, 'utf8'));

  it('DataConnector is declared in the gateway contract, distinct from SchemaSource', () => {
    expect(gateway).toContain('interface DataConnector');
    // It must NOT be defined by extending or aliasing SchemaSource.
    expect(gateway).not.toMatch(/interface DataConnector\s+extends\s+SchemaSource/);
    expect(gateway).not.toContain('SchemaSource');
  });

  it('SchemaSource (S4) still has NO row-reading method — Gateway did not leak into it', () => {
    // Re-pin the S4 promise from the Gateway side: seams.ts must not have grown a
    // row read while the raw-capable connector was introduced elsewhere.
    for (const forbidden of ['readRows', 'getRows', 'fetchRows', 'sampleRows', 'readData', 'readValues']) {
      // Allow the intentional "✗ readRows()" doc marker (comments already stripped
      // leaves only code); assert none appears as an actual member of SchemaSource.
      const schemaBody = interfaceBody(seams, 'SchemaSource');
      expect(schemaBody).not.toContain(forbidden);
    }
  });
});

describe('Phase 3A — Guard 6: audit + agent-log schemas are metadata-only', () => {
  const PII = ['aadhaar', 'pan', 'phone', 'email', 'address', 'name', 'dob'];
  const CONTENT = ['rows', 'cells', 'content', 'values', 'fileContents', 'queryResult', 'fileName', 'filePath'];

  it('the agent-log allowlist names no PII and no content field', () => {
    const lower = GATEWAY_LOG_FIELDS.map((f) => f.toLowerCase());
    for (const banned of [...PII, ...CONTENT]) expect(lower).not.toContain(banned.toLowerCase());
  });

  it('the audit metadata type names no PII and no content field', () => {
    const code = codeOnly(readFileSync(GATEWAY_CONTRACT, 'utf8'));
    const body = interfaceBody(code, 'GatewayAuditMetadata').toLowerCase();
    const fieldKeys = Array.from(body.matchAll(/(^|\n)\s*([a-z0-9_]+)\??\s*:/g)).map((m) => m[2] ?? '');
    for (const banned of [...PII, ...CONTENT]) expect(fieldKeys).not.toContain(banned.toLowerCase());
  });
});

describe('Phase 3A — Guard 8: data-plane read/search require source+session, no raw path', () => {
  const code = codeOnly(readFileSync(GATEWAY_CONTRACT, 'utf8'));

  it('read/search/metadata requests are source-scoped and name no path/SQL/table/credential', () => {
    for (const typeName of ['GatewaySourceReadRequest', 'GatewaySourceSearchRequest', 'GatewaySourceMetadataRequest']) {
      const body = interfaceBody(code, typeName);
      expect(body).toContain('sourceId');
      const fieldKeys = Array.from(body.matchAll(/(^|\n)\s*([a-zA-Z0-9_]+)\??\s*:/g)).map((m) => (m[2] ?? '').toLowerCase());
      // The browser must never name a resource directly — no path/glob, no raw
      // SQL/query, no table/schema name, no connection string or credential. It
      // sends only the OPAQUE handle; the Gateway resolves it internally.
      for (const forbidden of [
        'path', 'filepath', 'abspath', 'absolutepath', 'fullpath', 'glob',
        'sql', 'rawsql', 'query', 'statement',
        'table', 'tablename', 'schema', 'schemaname', 'collection',
        'connectionstring', 'dsn', 'credential', 'credentials', 'password', 'token',
      ]) {
        expect(fieldKeys).not.toContain(forbidden);
      }
    }
  });

  it('reads are by opaque handle, and bounded (limit/cursor exist on the read request)', () => {
    const body = interfaceBody(code, 'GatewaySourceReadRequest');
    expect(body).toContain('handle');
    expect(body).toContain('limit');
    expect(body).toContain('cursor');
    expect(body).toContain('requestId'); // cancelable/correlatable
  });

  it('there is no unrestricted "read everything" route or shape', () => {
    for (const banned of ['/all-data', '/dump', '/everything', 'allData', 'dumpAll', 'readAll']) {
      expect(code).not.toContain(banned);
    }
    // The data routes are exactly the bounded set.
    expect(Object.values(GATEWAY_DATA_ROUTES).sort()).toEqual(
      ['/health', '/session/establish', '/source/discover', '/source/metadata', '/source/read', '/source/search'].sort(),
    );
  });
});

describe('Phase 3A — Guard: the resource handle is source-agnostic and opaque', () => {
  const code = codeOnly(readFileSync(GATEWAY_CONTRACT, 'utf8'));

  it('ResourceKind supports at least file, table, and query', () => {
    for (const kind of ['file', 'table', 'query']) {
      expect([...RESOURCE_KINDS]).toContain(kind);
    }
  });

  it('the file-specific handle has been generalized away (no GatewayFileHandle)', () => {
    expect(code).toContain('interface ResourceHandle');
    expect(code).toContain('interface ResourceDescriptor');
    expect(code).not.toContain('interface GatewayFileHandle');
  });

  it('discover/search responses carry ResourceHandle[] — not a file-specific type', () => {
    for (const typeName of ['GatewaySourceDiscoverResponse', 'GatewaySourceSearchResponse']) {
      const body = interfaceBody(code, typeName);
      expect(body).toContain('ResourceHandle[]');
    }
  });

  it('ResourceHandle is opaque + descriptor-only — no path/SQL/table/credential/value field', () => {
    for (const typeName of ['ResourceHandle', 'ResourceDescriptor']) {
      const body = interfaceBody(code, typeName);
      const fieldKeys = Array.from(body.matchAll(/(^|\n)\s*([a-zA-Z0-9_]+)\??\s*:/g)).map((m) => (m[2] ?? '').toLowerCase());
      for (const forbidden of [
        'path', 'filepath', 'fullpath', 'sql', 'rawsql', 'query', 'statement',
        'tablename', 'schemaname', 'connectionstring', 'dsn', 'credential',
        'credentials', 'password', 'token', 'value', 'values', 'rows',
      ]) {
        expect(fieldKeys).not.toContain(forbidden);
      }
    }
    // The handle field itself is a plain opaque string.
    expect(interfaceBody(code, 'ResourceHandle')).toMatch(/handle\s*:\s*string/);
  });
});

describe('Phase 3A — Guard: filesystem resolver contract names every required step + threat', () => {
  it('the resolution pipeline is canonicalize → resolve links → descendant check → extension check', () => {
    expect([...GATEWAY_PATH_RESOLUTION_STEPS]).toEqual([
      'canonicalize',
      'resolve_symlinks_and_junctions',
      'verify_descendant_of_allowed_root',
      'verify_extension_allowlist',
    ]);
  });

  it('control routes and data routes are disjoint (planes do not share endpoints)', () => {
    const control = new Set<string>(Object.values(GATEWAY_CONTROL_ROUTES));
    for (const dataRoute of Object.values(GATEWAY_DATA_ROUTES)) {
      expect(control.has(dataRoute)).toBe(false);
    }
  });
});
