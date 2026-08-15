import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './session-store';
import { ConnectorRegistry } from './connectors/registry';
import {
  DataPlane,
  handleDataPlaneRequest,
  type ControlPlaneClient,
} from './data-plane';

const NOW = Date.now();
const FUTURE = new Date(NOW + 60_000).toISOString();

describe('Phase 3D — SessionStore binding', () => {
  const store = new SessionStore();
  store.put({ token: 'good', tenantId: 'A', sourceId: 'src1', deviceId: 'D', expiresAt: NOW + 60_000 });

  it('validates a good session bound to the right tenant + source', () => {
    expect(store.validate('good', { tenantId: 'A', sourceId: 'src1', now: NOW }).sourceId).toBe('src1');
  });
  it('invalid token fails', () => {
    expect(() => store.validate('nope', { tenantId: 'A', sourceId: 'src1', now: NOW })).toThrow(/INVALID_TOKEN/);
  });
  it('expired session fails', () => {
    store.put({ token: 'old', tenantId: 'A', sourceId: 'src1', deviceId: 'D', expiresAt: NOW - 1 });
    expect(() => store.validate('old', { tenantId: 'A', sourceId: 'src1', now: NOW })).toThrow(/SESSION_EXPIRED/);
  });
  it('tenant mismatch fails', () => {
    expect(() => store.validate('good', { tenantId: 'B', sourceId: 'src1', now: NOW })).toThrow(/TENANT_MISMATCH/);
  });
  it('source mismatch fails', () => {
    expect(() => store.validate('good', { tenantId: 'A', sourceId: 'src2', now: NOW })).toThrow(/SOURCE_MISMATCH/);
  });
});

describe('Phase 3D — DataPlane request handling', () => {
  let root: string;
  let dp: DataPlane;

  const fakeControl: ControlPlaneClient = {
    async redeemPairing() {
      return { sessionToken: 'SESSION-TOKEN', expiresAt: FUTURE };
    },
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-dp-'));
    writeFileSync(join(root, 'people.csv'), 'Name,Phone\nAsha,9876543210\nRavi,9812345678', 'utf8');
    const registry = new ConnectorRegistry([{ sourceId: 'src1', kind: 'csv', roots: [root] }]);
    dp = new DataPlane(registry, new SessionStore(), { tenantId: 'A', deviceId: 'D' }, fakeControl);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function establish() {
    const r = await handleDataPlaneRequest(dp, {
      method: 'POST',
      path: '/session/establish',
      sessionToken: undefined,
      body: { sourceId: 'src1', nonce: 'a-valid-nonce-value' },
    });
    expect(r.status).toBe(200);
    return (r.json as { sessionToken: string }).sessionToken;
  }

  it('establish → discover → read (raw rows returned to the authorized caller)', async () => {
    const token = await establish();
    const disc = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/discover', sessionToken: token, body: { sourceId: 'src1' } });
    expect(disc.status).toBe(200);
    const handle = (disc.json as { handles: { handle: string }[] }).handles[0]!.handle;

    const read = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/read', sessionToken: token, body: { sourceId: 'src1', handle } });
    expect(read.status).toBe(200);
    expect((read.json as { headers: string[] }).headers).toEqual(['Name', 'Phone']);
  });

  it('no session token fails 401', async () => {
    const r = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/discover', sessionToken: undefined, body: { sourceId: 'src1' } });
    expect(r).toMatchObject({ status: 401, json: { error: 'INVALID_TOKEN' } });
  });

  it('source mismatch fails 403', async () => {
    const token = await establish();
    const r = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/discover', sessionToken: token, body: { sourceId: 'src2' } });
    expect(r).toMatchObject({ status: 403, json: { error: 'SOURCE_MISMATCH' } });
  });

  it('tenant mismatch fails 403 (a session bound to another tenant)', async () => {
    // A different DataPlane for tenant B mints a session; tenant-A dp rejects it.
    const otherStore = new SessionStore();
    otherStore.put({ token: 'B-TOKEN', tenantId: 'B', sourceId: 'src1', deviceId: 'D', expiresAt: NOW + 60_000 });
    const dpB = new DataPlane(new ConnectorRegistry([{ sourceId: 'src1', kind: 'csv', roots: [root] }]), otherStore, { tenantId: 'A', deviceId: 'D' }, fakeControl);
    const r = await handleDataPlaneRequest(dpB, { method: 'POST', path: '/source/discover', sessionToken: 'B-TOKEN', body: { sourceId: 'src1' } });
    expect(r).toMatchObject({ status: 403, json: { error: 'TENANT_MISMATCH' } });
  });

  it('an invalid handle fails 404', async () => {
    const token = await establish();
    const r = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/read', sessionToken: token, body: { sourceId: 'src1', handle: 'bogus' } });
    expect(r).toMatchObject({ status: 404, json: { error: 'FILE_NOT_FOUND' } });
  });

  it('establishing on an unconfigured source fails 403', async () => {
    const r = await handleDataPlaneRequest(dp, { method: 'POST', path: '/session/establish', sessionToken: undefined, body: { sourceId: 'ghost', nonce: 'x'.repeat(16) } });
    expect(r).toMatchObject({ status: 403, json: { error: 'SOURCE_NOT_AUTHORIZED' } });
  });
});

describe('Phase 3G-2 — DataPlane customer routes: session/tenant/source binding', () => {
  let dpDb: DataPlane;

  const fakeControl: ControlPlaneClient = {
    async redeemPairing() {
      return { sessionToken: 'DB-SESSION-TOKEN', expiresAt: FUTURE };
    },
  };

  // A minimal fake DB client so the data-plane routes (which must reach a real
  // connector method, not just fail at the HTTP layer) actually exercise
  // resolveCustomer/writeCustomerFields/createCustomer/createColumn end to end.
  function fakeDbClient() {
    return {
      async query(sql: string) {
        if (/table_constraints|TABLE_CONSTRAINTS|indisprimary/i.test(sql)) return { columns: ['column_name'], rows: [['id']] };
        if (/information_schema\.columns|INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
          return { columns: ['column_name', 'data_type', 'is_nullable'], rows: [['email', 'text', 'YES'], ['mobile', 'text', 'YES']] };
        }
        if (/information_schema\.tables|INFORMATION_SCHEMA\.TABLES/i.test(sql)) {
          return { columns: ['schema', 'table'], rows: [['public', 'customers']] };
        }
        if (/ALTER TABLE/i.test(sql)) return { columns: [], rows: [] };
        if (/INSERT INTO/i.test(sql)) return { columns: [], rows: [] };
        if (/UPDATE .* SET/i.test(sql)) return { columns: [], rows: [] };
        if (/SELECT 1/i.test(sql)) return { columns: ['ok'], rows: [['1']] };
        // resolveCustomerSql
        return { columns: ['id'], rows: [['pkrow-1']] };
      },
      async close() {},
    };
  }

  beforeAll(() => {
    const registry = new ConnectorRegistry(
      [
        {
          sourceId: 'db1',
          kind: 'postgresql',
          connection: { host: 'h', port: 1, user: 'ro', password: 'p', database: 'd' },
          identityColumn: 'email',
          allowCustomerCreate: true,
          writableColumns: ['mobile'],
          writeConnection: { host: 'h', port: 1, user: 'rw', password: 'p2', database: 'd' },
        },
      ],
      () => fakeDbClient() as never,
    );
    dpDb = new DataPlane(registry, new SessionStore(), { tenantId: 'A', deviceId: 'D' }, fakeControl);
  });

  async function establishDb() {
    const r = await handleDataPlaneRequest(dpDb, {
      method: 'POST',
      path: '/session/establish',
      sessionToken: undefined,
      body: { sourceId: 'db1', nonce: 'a-valid-nonce-value' },
    });
    expect(r.status).toBe(200);
    return (r.json as { sessionToken: string }).sessionToken;
  }
  async function aHandle(token: string) {
    const disc = await handleDataPlaneRequest(dpDb, { method: 'POST', path: '/source/discover', sessionToken: token, body: { sourceId: 'db1' } });
    return (disc.json as { handles: { handle: string }[] }).handles[0]!.handle;
  }

  it('resolve → write happy path over the data plane', async () => {
    const token = await establishDb();
    const handle = await aHandle(token);
    const resolve = await handleDataPlaneRequest(dpDb, {
      method: 'POST',
      path: '/source/customer/resolve',
      sessionToken: token,
      body: { sourceId: 'db1', handle, identityValue: 'rahul@example.com' },
    });
    expect(resolve.status).toBe(200);
    const { customerRef } = resolve.json as { customerRef: string };
    expect(customerRef).toBeTruthy();

    const write = await handleDataPlaneRequest(dpDb, {
      method: 'POST',
      path: '/source/customer/write',
      sessionToken: token,
      body: { sourceId: 'db1', customerRef, fields: { mobile: '9876543210' } },
    });
    expect(write).toMatchObject({ status: 200, json: { success: true } });
  });

  it('no session token on any 3G-2 route fails 401', async () => {
    for (const path of ['/source/customer/resolve', '/source/customer/write', '/source/customer/create', '/source/column/create']) {
      const r = await handleDataPlaneRequest(dpDb, { method: 'POST', path, sessionToken: undefined, body: { sourceId: 'db1' } });
      expect(r).toMatchObject({ status: 401, json: { error: 'INVALID_TOKEN' } });
    }
  });

  it('source mismatch on a 3G-2 route fails 403', async () => {
    const token = await establishDb();
    const r = await handleDataPlaneRequest(dpDb, {
      method: 'POST',
      path: '/source/customer/resolve',
      sessionToken: token,
      body: { sourceId: 'some-other-source', handle: 'h', identityValue: 'x' },
    });
    expect(r).toMatchObject({ status: 403, json: { error: 'SOURCE_MISMATCH' } });
  });

  it('tenant mismatch on a 3G-2 route fails 403', async () => {
    const otherStore = new SessionStore();
    otherStore.put({ token: 'B-TOKEN', tenantId: 'B', sourceId: 'db1', deviceId: 'D', expiresAt: NOW + 60_000 });
    const registry = new ConnectorRegistry(
      [{ sourceId: 'db1', kind: 'postgresql', connection: { host: 'h', port: 1, user: 'ro', password: 'p', database: 'd' }, identityColumn: 'email' }],
      () => fakeDbClient() as never,
    );
    const dpB = new DataPlane(registry, otherStore, { tenantId: 'A', deviceId: 'D' }, fakeControl);
    const r = await handleDataPlaneRequest(dpB, {
      method: 'POST',
      path: '/source/customer/resolve',
      sessionToken: 'B-TOKEN',
      body: { sourceId: 'db1', handle: 'h', identityValue: 'x' },
    });
    expect(r).toMatchObject({ status: 403, json: { error: 'TENANT_MISMATCH' } });
  });

  it('an expired session on a 3G-2 route fails 401 SESSION_EXPIRED', async () => {
    const store = new SessionStore();
    store.put({ token: 'OLD', tenantId: 'A', sourceId: 'db1', deviceId: 'D', expiresAt: NOW - 1 });
    const registry = new ConnectorRegistry(
      [{ sourceId: 'db1', kind: 'postgresql', connection: { host: 'h', port: 1, user: 'ro', password: 'p', database: 'd' }, identityColumn: 'email' }],
      () => fakeDbClient() as never,
    );
    const dpExp = new DataPlane(registry, store, { tenantId: 'A', deviceId: 'D' }, fakeControl);
    const r = await handleDataPlaneRequest(dpExp, {
      method: 'POST',
      path: '/source/customer/resolve',
      sessionToken: 'OLD',
      body: { sourceId: 'db1', handle: 'h', identityValue: 'x' },
    });
    expect(r).toMatchObject({ status: 401, json: { error: 'SESSION_EXPIRED' } });
  });

  it('column creation with an unsupported/invalid type is rejected at the HTTP boundary (BAD_REQUEST)', async () => {
    const token = await establishDb();
    const handle = await aHandle(token);
    const r = await handleDataPlaneRequest(dpDb, {
      method: 'POST',
      path: '/source/column/create',
      sessionToken: token,
      body: { sourceId: 'db1', handle, columnName: 'new_col', columnType: 'jsonb' }, // not in the allowlist
    });
    expect(r.status).toBe(400);
  });

  it('a "fields" body that is not a flat string map is rejected (no nested object/array/number smuggled)', async () => {
    const token = await establishDb();
    const handle = await aHandle(token);
    const resolve = await handleDataPlaneRequest(dpDb, {
      method: 'POST',
      path: '/source/customer/resolve',
      sessionToken: token,
      body: { sourceId: 'db1', handle, identityValue: 'rahul@example.com' },
    });
    const { customerRef } = resolve.json as { customerRef: string };
    for (const badFields of [{ mobile: 123 }, { mobile: { nested: true } }, { mobile: ['a'] }]) {
      const r = await handleDataPlaneRequest(dpDb, {
        method: 'POST',
        path: '/source/customer/write',
        sessionToken: token,
        body: { sourceId: 'db1', customerRef, fields: badFields },
      });
      expect(r.status).toBe(400);
    }
  });

  it('an unmapped column sent over the data plane is rejected end to end (403 COLUMN_NOT_MAPPED)', async () => {
    const token = await establishDb();
    const handle = await aHandle(token);
    const resolve = await handleDataPlaneRequest(dpDb, {
      method: 'POST',
      path: '/source/customer/resolve',
      sessionToken: token,
      body: { sourceId: 'db1', handle, identityValue: 'rahul@example.com' },
    });
    const { customerRef } = resolve.json as { customerRef: string };
    const r = await handleDataPlaneRequest(dpDb, {
      method: 'POST',
      path: '/source/customer/write',
      sessionToken: token,
      body: { sourceId: 'db1', customerRef, fields: { email: 'new@example.com' } }, // email is NOT writable
    });
    expect(r).toMatchObject({ status: 403, json: { error: 'COLUMN_NOT_MAPPED' } });
  });
});

describe('Phase 3D — RAW-DATA BOUNDARY guard (connectors + data plane)', () => {
  const dir = __dirname;
  const CONNECTOR_FILES = [
    join(dir, 'connectors', 'filesystem-connector.ts'),
    join(dir, 'connectors', 'parsers.ts'),
    join(dir, 'connectors', 'path-safety.ts'),
    join(dir, 'connectors', 'registry.ts'),
    join(dir, 'session-store.ts'),
  ];
  const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('connectors never persist customer data (no file WRITE / browser storage)', () => {
    for (const f of CONNECTOR_FILES) {
      const src = codeOnly(readFileSync(f, 'utf8'));
      for (const banned of ['writeFileSync', 'appendFileSync', 'createWriteStream', 'writeFile(', 'localStorage', 'sessionStorage', 'indexedDB']) {
        expect({ f, banned, hit: src.includes(banned) }).toEqual({ f, banned, hit: false });
      }
    }
  });

  it('connectors make NO network call — raw rows never leave for Azure from here', () => {
    for (const f of CONNECTOR_FILES) {
      const src = codeOnly(readFileSync(f, 'utf8'));
      for (const banned of ['fetch(', 'http.request', 'https.request', 'XMLHttpRequest', 'WebSocket', 'axios']) {
        expect({ f, banned, hit: src.includes(banned) }).toEqual({ f, banned, hit: false });
      }
    }
  });

  it('the ONLY outbound call (control-plane redeem) sends metadata only — never rows', () => {
    const dp = codeOnly(readFileSync(join(dir, 'data-plane.ts'), 'utf8'));
    // exactly one fetch, in the control-plane client
    expect((dp.match(/fetch\(/g) ?? []).length).toBe(1);
    // The request BODY (not the fetch options) must be metadata only.
    const at = dp.indexOf('body: JSON.stringify(');
    expect(at).toBeGreaterThan(-1);
    const bodyArg = dp.slice(at, at + 60);
    for (const banned of ['rows', 'headers', 'parsed', 'values', 'buffer']) {
      expect({ banned, hit: bodyArg.includes(banned) }).toEqual({ banned, hit: false });
    }
    expect(bodyArg).toContain('nonce');
    expect(bodyArg).toContain('sourceId');
  });

  it('no raw rows/headers/values are ever logged', () => {
    for (const f of [...CONNECTOR_FILES, join(dir, 'data-plane.ts')]) {
      const src = codeOnly(readFileSync(f, 'utf8'));
      for (const line of src.split('\n')) {
        if (!/\bconsole\s*\./.test(line)) continue;
        for (const banned of ['rows', 'headers', 'row[', 'values', 'parsed', 'buffer']) {
          expect({ f, banned, hit: line.toLowerCase().includes(banned) }).toEqual({ f, banned, hit: false });
        }
      }
    }
  });
});
