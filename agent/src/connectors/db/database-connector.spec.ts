import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSourceKind } from '@dpdp/shared';
import { ConnectorError } from '../filesystem-connector';
import { ConnectorRegistry, loadSourceConfig } from '../registry';
import { DatabaseConnector } from './database-connector';
import { dialectFor, mysqlDialect, postgresDialect, sqlserverDialect } from './dialect';
import type { DbClient, DbClientFactory } from './db-client';

interface Call {
  sql: string;
  params: unknown[];
}

/** A configurable fake DbClient — no live database needed. */
function fakeClient(cfg: {
  tablesRef: { value: string[][] };
  readColumns?: string[];
  readRows?: string[][];
  fieldsRows?: string[][];
  throwErr?: Error;
  calls: Call[];
}): DbClient {
  return {
    async query(sql, params) {
      cfg.calls.push({ sql, params });
      if (cfg.throwErr) throw cfg.throwErr;
      if (/information_schema\.columns|INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
        return {
          columns: ['column_name', 'data_type', 'is_nullable'],
          rows: cfg.fieldsRows ?? [
            ['customer_name', 'text', 'YES'],
            ['mobile', 'text', 'YES'],
            ['email', 'text', 'YES'],
            ['aadhaar_number', 'text', 'YES'],
          ],
        };
      }
      if (/information_schema\.tables|INFORMATION_SCHEMA\.TABLES/i.test(sql)) {
        return { columns: ['schema', 'table'], rows: cfg.tablesRef.value };
      }
      if (/SELECT 1/i.test(sql)) return { columns: ['ok'], rows: [['1']] };
      return { columns: cfg.readColumns ?? ['Name', 'Aadhaar'], rows: cfg.readRows ?? [['Asha', '999988887777']] };
    },
    async close() {},
  };
}

function make(dialectKind: DataSourceKind, over: Partial<Parameters<typeof fakeClient>[0]> = {}) {
  const calls: Call[] = [];
  const tablesRef = over.tablesRef ?? { value: [['public', 'customers'], ['public', 'orders']] };
  const client = fakeClient({
    tablesRef,
    calls,
    readColumns: over.readColumns,
    readRows: over.readRows,
    fieldsRows: over.fieldsRows,
    throwErr: over.throwErr,
  });
  const connector = new DatabaseConnector(dialectFor(dialectKind)!, () => client);
  return { connector, calls, tablesRef };
}

const DIALECTS: [string, DataSourceKind][] = [
  ['PostgreSQL', 'postgresql'],
  ['MySQL', 'mysql'],
  ['SQL Server', 'sqlserver'],
];

describe.each(DIALECTS)('Phase 3E — %s connector', (_name, kind) => {
  it('connects (healthCheck) and discovers tables as opaque "table" handles', async () => {
    const { connector } = make(kind);
    expect(await connector.healthCheck()).toMatchObject({ status: 'ok' });
    const disc = await connector.discover();
    expect(disc.handles.map((h) => h.descriptor.label)).toEqual(['public.customers', 'public.orders']);
    expect(disc.handles.every((h) => h.descriptor.resourceKind === 'table')).toBe(true);
    // opaque — not the table name
    expect(disc.handles.every((h) => !h.handle.includes('customers'))).toBe(true);
  });

  it('reads a bounded page of an authorized table (parameterized)', async () => {
    const { connector, calls } = make(kind);
    const { handles } = await connector.discover();
    const rows = await connector.read(handles[0]!.handle, { limit: 50 });
    expect(rows.headers).toEqual(['Name', 'Aadhaar']);
    expect(rows.rows.flat()).toContain('999988887777');
    const readCall = calls.find((c) => /SELECT \* FROM/i.test(c.sql))!;
    expect(readCall.params).toContain(50); // bound value, not concatenated
  });

  it('Phase 3G-1: listFields returns column NAMES/types only — never a customer row', async () => {
    const { connector, calls } = make(kind, {
      fieldsRows: [
        ['customer_name', 'text', 'YES'],
        ['aadhaar_number', 'text', 'YES'],
        ['pan_number', 'text', 'NO'],
      ],
    });
    const { handles } = await connector.discover();
    const res = await connector.listFields(handles[0]!.handle);
    expect(res.fields).toEqual([
      { name: 'customer_name', type: 'text', nullable: true },
      { name: 'aadhaar_number', type: 'text', nullable: true },
      { name: 'pan_number', type: 'text', nullable: false },
    ]);
    // it queries information_schema.columns with the table PARAMETERIZED, not concatenated
    const fieldsCall = calls.find((c) => /information_schema\.columns|INFORMATION_SCHEMA\.COLUMNS/i.test(c.sql))!;
    expect(fieldsCall.params).toContain('customers');
    expect(fieldsCall.sql).not.toContain('customers'); // the table name is bound, not inlined
    // no customer VALUE anywhere in the response
    expect(JSON.stringify(res)).not.toContain('999988887777');
  });

  it('listFields on an invalid/tampered handle fails closed', async () => {
    const { connector } = make(kind);
    await connector.discover();
    await expect(connector.listFields('tampered-handle-xyz')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('enforces the row limit (a huge limit is clamped)', async () => {
    const { connector, calls } = make(kind);
    const { handles } = await connector.discover();
    await connector.read(handles[0]!.handle, { limit: 1_000_000 });
    const readCall = calls.find((c) => /SELECT \* FROM/i.test(c.sql))!;
    expect(readCall.params).toContain(1000); // GATEWAY_READ_MAX_LIMIT
    expect(readCall.params).not.toContain(1_000_000);
  });

  it('rejects an invalid / tampered handle (fail closed)', async () => {
    const { connector } = make(kind);
    await connector.discover();
    await expect(connector.read('tampered-handle-xyz')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('rejects a handle for a table no longer authorized', async () => {
    const { connector, tablesRef } = make(kind);
    const { handles } = await connector.discover();
    const customers = handles.find((h) => h.descriptor.label === 'public.customers')!.handle;
    // Re-discovery no longer includes customers → its handle is unauthorized now.
    tablesRef.value = [['public', 'orders']];
    await connector.discover();
    await expect(connector.read(customers)).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });

  it('search filters table names in memory — a SQL-injection term never reaches a query', async () => {
    const { connector, calls } = make(kind);
    const evil = "'; DROP TABLE customers; --";
    const res = await connector.search(evil);
    expect(res.handles).toEqual([]); // no table name matches
    expect(calls.every((c) => !/DROP TABLE/i.test(c.sql))).toBe(true);
    expect(calls.every((c) => !c.sql.includes(evil))).toBe(true);
  });

  it('propagates a query TIMEOUT (cancellation)', async () => {
    const { connector } = make(kind, { throwErr: new ConnectorError('TIMEOUT') });
    await expect(connector.healthCheck()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('sanitizes invalid-credentials errors — the driver message never escapes', async () => {
    const { connector } = make(kind, { throwErr: new Error('FATAL: password authentication failed for user "admin"') });
    try {
      await connector.healthCheck();
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ConnectorError).code).toBe('PERMISSION_DENIED');
      expect((e as Error).message).toBe('PERMISSION_DENIED');
      expect((e as Error).message).not.toMatch(/password|admin/);
    }
  });

  it('sanitizes unreachable-database errors', async () => {
    const { connector } = make(kind, { throwErr: new Error('connect ECONNREFUSED 10.20.30.40:5432') });
    await expect(connector.discover()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    try {
      await connector.discover();
    } catch (e) {
      expect((e as Error).message).not.toMatch(/ECONNREFUSED|10\.20\.30\.40/);
    }
  });

  it('never returns credentials in any response', async () => {
    // Build a connector whose client closure holds a password; responses must not leak it.
    const calls: Call[] = [];
    const tablesRef = { value: [['public', 'customers']] };
    const PW = 'SUPER_SECRET_PW_123';
    const connector = new DatabaseConnector(dialectFor(kind)!, () => {
      void PW; // the password lives in the client's config, never in a response
      return fakeClient({ tablesRef, calls });
    });
    const disc = await connector.discover();
    const rows = await connector.read(disc.handles[0]!.handle);
    expect(JSON.stringify(disc)).not.toContain(PW);
    expect(JSON.stringify(rows)).not.toContain(PW);
  });
});

describe('Phase 3E — the dialects parameterize values and quote identifiers', () => {
  it('PostgreSQL uses $-placeholders + double-quoted identifiers', () => {
    const r = postgresDialect.readSql('sch"ema', 'tab"le', 100, 0);
    expect(r.sql).toContain('LIMIT $1 OFFSET $2');
    expect(r.sql).toContain('"sch""ema"."tab""le"'); // quote-escaped
    expect(r.params).toEqual([100, 0]);
  });
  it('MySQL uses ?-placeholders + backtick identifiers', () => {
    const r = mysqlDialect.readSql('db', 'tbl', 100, 0);
    expect(r.sql).toContain('LIMIT ? OFFSET ?');
    expect(r.sql).toContain('`db`.`tbl`');
    expect(r.params).toEqual([100, 0]);
  });
  it('SQL Server uses @p-placeholders + bracket identifiers + OFFSET/FETCH', () => {
    const r = sqlserverDialect.readSql('dbo', 'People', 100, 20);
    expect(r.sql).toContain('OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY');
    expect(r.sql).toContain('[dbo].[People]');
    expect(r.params).toEqual([20, 100]); // offset, limit
  });
});

describe('Phase 3E — ConnectorRegistry supports databases + fails closed', () => {
  const factory: DbClientFactory = () => ({ async query() { return { columns: [], rows: [] }; }, async close() {} });

  it.each(DIALECTS)('builds a %s connector from a source with a connection', (_n, kind) => {
    const reg = new ConnectorRegistry(
      [{ sourceId: 'db1', kind, connection: { host: 'h', port: 1, user: 'u', password: 'p', database: 'd' } }],
      factory,
    );
    expect(reg.get('db1')).toBeInstanceOf(DatabaseConnector);
    expect(reg.get('db1')).toBe(reg.get('db1')); // cached
  });

  it('a DB source without a connection fails closed', () => {
    const reg = new ConnectorRegistry([{ sourceId: 'db1', kind: 'postgresql' }], factory);
    expect(() => reg.get('db1')).toThrow(ConnectorError);
  });

  it('an unsupported future kind (e.g. oracle) fails closed', () => {
    const reg = new ConnectorRegistry([{ sourceId: 'x', kind: 'oracle' as DataSourceKind, connection: { host: 'h', port: 1, user: 'u', password: 'p', database: 'd' } }], factory);
    try {
      reg.get('x');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ConnectorError).code).toBe('UNSUPPORTED_SOURCE');
    }
  });

  it('still builds file connectors (CSV/XLSX/filesystem unchanged)', () => {
    const reg = new ConnectorRegistry([{ sourceId: 'f', kind: 'csv', roots: [process.cwd()] }], factory);
    expect(reg.get('f').sourceKind).toBe('csv');
  });
});

describe('Phase 3F — DB/network config is fully config-driven (nothing hardcoded)', () => {
  it('parses host/port/user/password/database/ssl from configuration', () => {
    const env = {
      GATEWAY_SOURCES: JSON.stringify([
        { sourceId: 'pg1', kind: 'postgresql', connection: { host: 'db.customer.example', port: 6543, user: 'ro', password: 'pw', database: 'app', ssl: true } },
      ]),
    } as NodeJS.ProcessEnv;
    const [cfg] = loadSourceConfig(env);
    expect(cfg!.connection).toEqual({ host: 'db.customer.example', port: 6543, user: 'ro', password: 'pw', database: 'app', ssl: true });
  });

  it('has no hardcoded host/ip/port in the registry or dialect code', () => {
    for (const f of ['../registry.ts', 'dialect.ts', 'db-client.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/127\.0\.0\.1|localhost|192\.168\.|10\.0\.0\.|:5432|:3306|:1433/);
    }
  });
});

describe('Phase 3E — DB raw-data boundary guard', () => {
  const dir = __dirname;
  const FILES = ['database-connector.ts', 'dialect.ts', 'db-client.ts'].map((f) => join(dir, f));
  const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('no credentials/SQL/rows are ever logged (no console in DB files)', () => {
    for (const f of FILES) {
      expect({ f, hit: /\bconsole\s*\./.test(codeOnly(readFileSync(f, 'utf8'))) }).toEqual({ f, hit: false });
    }
  });

  it('search terms / values are never concatenated into SQL', () => {
    const conn = codeOnly(readFileSync(join(dir, 'database-connector.ts'), 'utf8'));
    for (const banned of ['${term', '+ term', '${q}', '${value', 'query(`SELECT', "query('SELECT"]) {
      expect({ banned, hit: conn.includes(banned) }).toEqual({ banned, hit: false });
    }
  });

  it('the connector makes no network/persistence/raw-relay call itself', () => {
    for (const f of FILES) {
      const src = codeOnly(readFileSync(f, 'utf8'));
      for (const banned of ['fetch(', 'writeFileSync', 'localStorage', 'axios', 'XMLHttpRequest']) {
        expect({ f, banned, hit: src.includes(banned) }).toEqual({ f, banned, hit: false });
      }
    }
  });
});
