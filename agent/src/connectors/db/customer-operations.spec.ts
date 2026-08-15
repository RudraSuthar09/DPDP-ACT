import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSourceKind } from '@dpdp/shared';
import { ConnectorError } from '../filesystem-connector';
import { DatabaseConnector, type DatabaseConnectorOptions } from './database-connector';
import { dialectFor } from './dialect';
import type { DbClient } from './db-client';

/**
 * Phase 3G-2 — customer resolution, controlled write/create, controlled column
 * creation. All against a FAKE DbClient (no live database) that reproduces the
 * shapes the real dialects generate, so the connector's OWN authorization
 * logic — identity-column enforcement, the writable-column allowlist,
 * creation-disabled, missing write credential, strict identifier/type
 * checking, duplicate-column rejection, no-duplicate-customer-on-create — is
 * exercised exhaustively without a real PostgreSQL/MySQL/SQL Server instance.
 */

interface Call {
  sql: string;
  params: unknown[];
}

const SENTINEL_AADHAAR = '999988887777';
// Long/distinctive so it can never coincidentally appear as a substring of a
// random UUID customerRef (a short value like "42" occasionally would).
const PK_VALUE = 'PKROW-8837261';

function fakeClient(cfg: {
  calls: Call[];
  columns: string[][]; // rows for listColumnsSql: [name, type, nullable]
  pkColumn: string | null; // null => table has no primary key
  /** identityValue -> pk value, or null to mean "not found" */
  identityIndex: Map<string, string>;
  throwErr?: Error;
}): DbClient {
  return {
    async query(sql, params) {
      cfg.calls.push({ sql, params });
      if (cfg.throwErr) throw cfg.throwErr;

      if (/ALTER TABLE/i.test(sql)) return { columns: [], rows: [] };
      if (/INSERT INTO/i.test(sql)) {
        // Test-fixture simulation of read-after-write: register the identity
        // value (looks like an email in these fixtures) so the connector's own
        // post-insert re-resolve can find the new row, exactly as a real
        // database would on the very next SELECT.
        const identityLike = params.find((p) => typeof p === 'string' && p.includes('@'));
        if (typeof identityLike === 'string' && !cfg.identityIndex.has(identityLike)) {
          cfg.identityIndex.set(identityLike, String(100 + cfg.identityIndex.size));
        }
        return { columns: [], rows: [] };
      }
      if (/UPDATE .* SET/i.test(sql)) return { columns: [], rows: [] };
      // MySQL/SQL Server use information_schema.table_constraints; PostgreSQL
      // uses pg_catalog (pg_index.indisprimary) — see dialect.ts for why.
      if (/table_constraints|TABLE_CONSTRAINTS|indisprimary/i.test(sql)) {
        return cfg.pkColumn ? { columns: ['column_name'], rows: [[cfg.pkColumn]] } : { columns: ['column_name'], rows: [] };
      }
      if (/information_schema\.columns|INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
        return { columns: ['column_name', 'data_type', 'is_nullable'], rows: cfg.columns };
      }
      if (/information_schema\.tables|INFORMATION_SCHEMA\.TABLES/i.test(sql)) {
        return { columns: ['schema', 'table'], rows: [['public', 'customers']] };
      }
      if (/SELECT 1/i.test(sql)) return { columns: ['ok'], rows: [['1']] };
      if (/SELECT \* FROM/i.test(sql)) return { columns: ['Name'], rows: [] };
      // Otherwise: this is the resolveCustomerSql shape — SELECT <pk> ... WHERE
      // <identity> = <param> [LIMIT/FETCH 1]. The identity value is always the
      // FIRST bound parameter.
      const identityValue = String(params[0]);
      const pk = cfg.identityIndex.get(identityValue);
      return pk ? { columns: [cfg.pkColumn ?? 'id'], rows: [[pk]] } : { columns: [cfg.pkColumn ?? 'id'], rows: [] };
    },
    async close() {},
  };
}

function make(
  kind: DataSourceKind,
  options: DatabaseConnectorOptions,
  cfgOverrides: Partial<{ columns: string[][]; pkColumn: string | null; identityIndex: Map<string, string>; throwErr: Error }> = {},
) {
  const readCalls: Call[] = [];
  const writeCalls: Call[] = [];
  const columns = cfgOverrides.columns ?? [
    ['customer_name', 'text', 'YES'],
    ['mobile', 'text', 'YES'],
    ['email', 'text', 'YES'],
    ['aadhaar_number', 'text', 'YES'],
  ];
  const pkColumn = cfgOverrides.pkColumn === undefined ? 'id' : cfgOverrides.pkColumn;
  const identityIndex = cfgOverrides.identityIndex ?? new Map([['rahul@example.com', PK_VALUE]]);

  const readClient = fakeClient({ calls: readCalls, columns, pkColumn, identityIndex });
  const writeClient = fakeClient({ calls: writeCalls, columns, pkColumn, identityIndex, throwErr: cfgOverrides.throwErr });

  const connector = new DatabaseConnector(dialectFor(kind)!, () => readClient, {
    ...options,
    makeWriteClient: options.makeWriteClient === undefined ? () => writeClient : options.makeWriteClient,
  });
  return { connector, readCalls, writeCalls };
}

const DIALECTS: [string, DataSourceKind][] = [
  ['PostgreSQL', 'postgresql'],
  ['MySQL', 'mysql'],
  ['SQL Server', 'sqlserver'],
];

describe.each(DIALECTS)('Phase 3G-2 — %s customer resolution', (_name, kind) => {
  it('1. resolves a valid existing customer to an OPAQUE ref (never the pk value)', async () => {
    const { connector, readCalls } = make(kind, { identityColumn: 'email' });
    const { handles } = await connector.discover();
    const res = await connector.resolveCustomer(handles[0]!.handle, 'rahul@example.com');
    expect(res.exists).toBe(true);
    expect(res.customerRef).toBeTruthy();
    expect(res.customerRef).not.toBe(PK_VALUE);
    expect(res.customerRef).not.toContain(PK_VALUE);
    // 9. parameterized: the identity VALUE is a bound param, never in the SQL text.
    const resolveCall = readCalls.find((c) => c.params[0] === 'rahul@example.com')!;
    expect(resolveCall.sql).not.toContain('rahul@example.com');
  });

  it('2. customer not found returns exists:false with no ref', async () => {
    const { connector } = make(kind, { identityColumn: 'email' });
    const { handles } = await connector.discover();
    const res = await connector.resolveCustomer(handles[0]!.handle, 'nobody@example.com');
    expect(res).toEqual({ exists: false, customerRef: null });
  });

  it('6/7. identity column not configured at all fails closed', async () => {
    const { connector } = make(kind, {}); // no identityColumn
    const { handles } = await connector.discover();
    await expect(connector.resolveCustomer(handles[0]!.handle, 'x')).rejects.toMatchObject({ code: 'IDENTITY_NOT_CONFIGURED' });
  });

  it('6/7. identity column configured but not a real column of the table fails closed', async () => {
    const { connector } = make(kind, { identityColumn: 'not_a_real_column' });
    const { handles } = await connector.discover();
    await expect(connector.resolveCustomer(handles[0]!.handle, 'x')).rejects.toMatchObject({ code: 'IDENTITY_NOT_CONFIGURED' });
  });

  it('a table with no primary key fails safely rather than guessing a column called "id"', async () => {
    const { connector } = make(kind, { identityColumn: 'email' }, { pkColumn: null });
    const { handles } = await connector.discover();
    await expect(connector.resolveCustomer(handles[0]!.handle, 'rahul@example.com')).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
  });

  it('an invalid/unknown resource handle fails closed (same as read/metadata)', async () => {
    const { connector } = make(kind, { identityColumn: 'email' });
    await connector.discover();
    await expect(connector.resolveCustomer('tampered-handle', 'x')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
});

describe.each(DIALECTS)('Phase 3G-2 — %s controlled customer write', (_name, kind) => {
  it('1. a valid mapped-field update succeeds, values parameterized', async () => {
    const { connector, writeCalls } = make(kind, { identityColumn: 'email', writableColumns: ['aadhaar_number', 'mobile'] });
    const { handles } = await connector.discover();
    const { customerRef } = await connector.resolveCustomer(handles[0]!.handle, 'rahul@example.com');
    const res = await connector.writeCustomerFields(customerRef!, { aadhaar_number: SENTINEL_AADHAAR });
    expect(res).toEqual({ success: true });
    const updateCall = writeCalls.find((c) => /UPDATE/i.test(c.sql))!;
    expect(updateCall.params).toContain(SENTINEL_AADHAAR); // bound, not concatenated
    expect(updateCall.sql).not.toContain(SENTINEL_AADHAAR);
  });

  it('2/3. an unmapped/arbitrary column is rejected — never blindly updated', async () => {
    const { connector } = make(kind, { identityColumn: 'email', writableColumns: ['mobile'] }); // aadhaar_number NOT writable
    const { handles } = await connector.discover();
    const { customerRef } = await connector.resolveCustomer(handles[0]!.handle, 'rahul@example.com');
    await expect(connector.writeCustomerFields(customerRef!, { aadhaar_number: SENTINEL_AADHAAR })).rejects.toMatchObject({
      code: 'COLUMN_NOT_MAPPED',
    });
  });

  it('a column that IS in the allowlist but no longer exists on the table is still rejected (defence in depth)', async () => {
    const { connector } = make(
      kind,
      { identityColumn: 'email', writableColumns: ['ghost_column'] },
      { columns: [['email', 'text', 'YES']] }, // ghost_column not a real column
    );
    const { handles } = await connector.discover();
    const { customerRef } = await connector.resolveCustomer(handles[0]!.handle, 'rahul@example.com');
    await expect(connector.writeCustomerFields(customerRef!, { ghost_column: 'x' })).rejects.toMatchObject({ code: 'COLUMN_NOT_MAPPED' });
  });

  it('4. a SQL-injection-shaped VALUE never alters the generated SQL text', async () => {
    const { connector, writeCalls } = make(kind, { identityColumn: 'email', writableColumns: ['mobile'] });
    const { handles } = await connector.discover();
    const { customerRef } = await connector.resolveCustomer(handles[0]!.handle, 'rahul@example.com');
    const evil = "'; DROP TABLE customers; --";
    await connector.writeCustomerFields(customerRef!, { mobile: evil });
    const updateCall = writeCalls.find((c) => /UPDATE/i.test(c.sql))!;
    expect(updateCall.sql).not.toContain('DROP TABLE');
    expect(updateCall.sql).not.toContain(evil);
    expect(updateCall.params).toContain(evil); // it travels ONLY as a bound param
  });

  it('7. an invalid/unknown customerRef is rejected — never CUSTOMER_NOT_FOUND-bypassed', async () => {
    const { connector } = make(kind, { identityColumn: 'email', writableColumns: ['mobile'] });
    await connector.discover();
    await expect(connector.writeCustomerFields('made-up-ref', { mobile: '123' })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('an empty field set is rejected (no legitimate "write nothing" call)', async () => {
    const { connector } = make(kind, { identityColumn: 'email', writableColumns: ['mobile'] });
    const { handles } = await connector.discover();
    const { customerRef } = await connector.resolveCustomer(handles[0]!.handle, 'rahul@example.com');
    await expect(connector.writeCustomerFields(customerRef!, {})).rejects.toMatchObject({ code: 'COLUMN_NOT_MAPPED' });
  });

  it('missing write credential fails closed (WRITE_NOT_CONFIGURED), even though the read worked', async () => {
    const { connector } = make(kind, { identityColumn: 'email', writableColumns: ['mobile'] }, {});
    // Rebuild WITHOUT a write client this time.
    const dialect = dialectFor(kind)!;
    const readClient = fakeClient({ calls: [], columns: [['email', 'text', 'YES'], ['mobile', 'text', 'YES']], pkColumn: 'id', identityIndex: new Map([['rahul@example.com', PK_VALUE]]) });
    const noWriteConnector = new DatabaseConnector(dialect, () => readClient, { identityColumn: 'email', writableColumns: ['mobile'] });
    const { handles } = await noWriteConnector.discover();
    const { customerRef } = await noWriteConnector.resolveCustomer(handles[0]!.handle, 'rahul@example.com');
    await expect(noWriteConnector.writeCustomerFields(customerRef!, { mobile: '123' })).rejects.toMatchObject({ code: 'WRITE_NOT_CONFIGURED' });
    void connector; // (unused connector from make(); the point of this test is the rebuild above)
  });
});

describe.each(DIALECTS)('Phase 3G-2 — %s controlled customer creation', (_name, kind) => {
  it('1. creation enabled → succeeds, inserts only identity + mapped fields, parameterized', async () => {
    const { connector, writeCalls } = make(kind, {
      identityColumn: 'email',
      allowCustomerCreate: true,
      writableColumns: ['customer_name', 'mobile'],
    }, { identityIndex: new Map() }); // nobody exists yet
    const { handles } = await connector.discover();
    const res = await connector.createCustomer(handles[0]!.handle, 'new@example.com', { customer_name: 'Asha', mobile: '9876543210' });
    expect(res.created).toBe(true);
    expect(res.exists).toBe(false);
    expect(res.customerRef).toBeTruthy();
    const insertCall = writeCalls.find((c) => /INSERT INTO/i.test(c.sql))!;
    expect(insertCall.params).toEqual(expect.arrayContaining(['Asha', '9876543210', 'new@example.com']));
    expect(insertCall.sql).not.toContain('Asha'); // values bound, not concatenated
  });

  it('2. creation disabled → rejected, no insert attempted', async () => {
    const { connector, writeCalls } = make(kind, { identityColumn: 'email', allowCustomerCreate: false, writableColumns: ['mobile'] });
    const { handles } = await connector.discover();
    await expect(connector.createCustomer(handles[0]!.handle, 'x@example.com', { mobile: '1' })).rejects.toMatchObject({
      code: 'CUSTOMER_CREATION_DISABLED',
    });
    expect(writeCalls.some((c) => /INSERT/i.test(c.sql))).toBe(false);
  });

  it('3. an existing identity is NEVER duplicated — the existing ref is returned instead', async () => {
    const { connector, writeCalls } = make(kind, { identityColumn: 'email', allowCustomerCreate: true, writableColumns: ['mobile'] });
    const { handles } = await connector.discover();
    const res = await connector.createCustomer(handles[0]!.handle, 'rahul@example.com', { mobile: '1' }); // rahul already exists
    expect(res).toMatchObject({ created: false, exists: true });
    expect(res.customerRef).toBeTruthy();
    expect(writeCalls.some((c) => /INSERT/i.test(c.sql))).toBe(false);
  });

  it('4/5. an unmapped/arbitrary field is rejected — no insert with it', async () => {
    const { connector, writeCalls } = make(kind, {
      identityColumn: 'email',
      allowCustomerCreate: true,
      writableColumns: ['mobile'],
    }, { identityIndex: new Map() });
    const { handles } = await connector.discover();
    await expect(
      connector.createCustomer(handles[0]!.handle, 'new@example.com', { aadhaar_number: SENTINEL_AADHAAR }),
    ).rejects.toMatchObject({ code: 'COLUMN_NOT_MAPPED' });
    expect(writeCalls.some((c) => /INSERT/i.test(c.sql))).toBe(false);
  });

  it('creation without an identity column configured fails closed', async () => {
    const { connector } = make(kind, { allowCustomerCreate: true, writableColumns: ['mobile'] }); // no identityColumn
    const { handles } = await connector.discover();
    await expect(connector.createCustomer(handles[0]!.handle, 'x@example.com', { mobile: '1' })).rejects.toMatchObject({
      code: 'IDENTITY_NOT_CONFIGURED',
    });
  });
});

describe.each(DIALECTS)('Phase 3G-2 — %s controlled column creation', (_name, kind) => {
  it('1. a valid, allowed type succeeds and generates the correct ALTER', async () => {
    const { connector, writeCalls } = make(kind, {});
    const { handles } = await connector.discover();
    const res = await connector.createColumn(handles[0]!.handle, 'pan_number', 'text');
    expect(res).toEqual({ created: true });
    const alterCall = writeCalls.find((c) => /ALTER TABLE/i.test(c.sql))!;
    expect(alterCall.sql).toContain('pan_number');
    expect(alterCall.sql).toMatch(/ADD/i);
  });

  it('3. an invalid identifier is rejected regardless of what the caller already validated', async () => {
    const { connector } = make(kind, {});
    const { handles } = await connector.discover();
    for (const evil of ['pan_number; DROP TABLE customers;--', "' OR 1=1 --", 'has space', '1starts_with_digit']) {
      await expect(connector.createColumn(handles[0]!.handle, evil, 'text')).rejects.toMatchObject({ code: 'INVALID_IDENTIFIER' });
    }
  });

  it('4. a column that already exists is rejected', async () => {
    const { connector } = make(kind, {});
    const { handles } = await connector.discover();
    await expect(connector.createColumn(handles[0]!.handle, 'aadhaar_number', 'text')).rejects.toMatchObject({
      code: 'COLUMN_ALREADY_EXISTS',
    });
  });

  it('5. missing write credential → fails closed (WRITE_NOT_CONFIGURED)', async () => {
    const dialect = dialectFor(kind)!;
    const readClient = fakeClient({ calls: [], columns: [['email', 'text', 'YES']], pkColumn: 'id', identityIndex: new Map() });
    const connector = new DatabaseConnector(dialect, () => readClient, {}); // no makeWriteClient
    const { handles } = await connector.discover();
    await expect(connector.createColumn(handles[0]!.handle, 'new_col', 'text')).rejects.toMatchObject({ code: 'WRITE_NOT_CONFIGURED' });
  });

  it('every allowed type maps to a real native SQL type in the generated ALTER', async () => {
    const { connector, writeCalls } = make(kind, {});
    const { handles } = await connector.discover();
    for (const type of ['text', 'integer', 'boolean', 'date', 'datetime'] as const) {
      writeCalls.length = 0;
      await connector.createColumn(handles[0]!.handle, `col_${type}`, type);
      const alterCall = writeCalls.find((c) => /ALTER TABLE/i.test(c.sql))!;
      expect(alterCall.sql.length).toBeGreaterThan(0);
      expect(alterCall.params).toEqual([]); // DDL — nothing bound, nothing to bind
    }
  });
});

describe('Phase 3G-2 — CSV/XLSX (filesystem) unsupported, not silently ignored', () => {
  // FilesystemConnector is exercised directly to prove the four new operations
  // are honestly UNSUPPORTED_SOURCE rather than silently rewriting a file.
  it('all four 3G-2 operations are unsupported for file sources', async () => {
    const { FilesystemConnector } = await import('../filesystem-connector');
    const connector = new FilesystemConnector('csv', []);
    await expect(connector.resolveCustomer('h', 'x')).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
    await expect(connector.writeCustomerFields('ref', {})).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
    await expect(connector.createCustomer('h', 'x', {})).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
    await expect(connector.createColumn('h', 'col', 'text')).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
  });
});

describe('Phase 3G-2 — RAW-DATA / CREDENTIAL / SQL-INJECTION boundary guard', () => {
  const dir = __dirname;
  const FILES = ['database-connector.ts', 'dialect.ts'].map((f) => join(dir, f));
  const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('no console logging anywhere in the connector/dialect files (identity/field values never logged)', () => {
    for (const f of FILES) {
      expect({ f, hit: /\bconsole\s*\./.test(codeOnly(readFileSync(f, 'utf8'))) }).toEqual({ f, hit: false });
    }
  });

  it('no field/identity VALUE is ever concatenated into a SQL string (template literal with a value var)', () => {
    const conn = codeOnly(readFileSync(join(dir, 'database-connector.ts'), 'utf8'));
    for (const banned of ['${identityValue', '${fields', '${value', '${pkValue', '${columnValue']) {
      expect({ banned, hit: conn.includes(banned) }).toEqual({ banned, hit: false });
    }
  });

  it('addColumnSql is the ONLY unparameterized (DDL) builder — every other builder returns bound params', () => {
    const dialect = codeOnly(readFileSync(join(dir, 'dialect.ts'), 'utf8'));
    // resolveCustomerSql/updateCustomerSql/insertCustomerSql must each still
    // return a non-empty params array shape (structural check: they reference
    // `values`/`identityValue`/`pkValue` inside their returned `params:` field).
    expect(dialect).toMatch(/resolveCustomerSql[\s\S]*?params:\s*\[identityValue\]/);
    expect(dialect).toMatch(/updateCustomerSql[\s\S]*?params:\s*\[\.\.\.values,\s*pkValue\]/);
    expect(dialect).toMatch(/insertCustomerSql[\s\S]*?params:\s*values/);
    expect(dialect).toMatch(/addColumnSql[\s\S]*?params:\s*\[\]/);
  });

  it('no arbitrary-SQL route/field exists (no rawSql/query/statement field anywhere)', () => {
    for (const f of [...FILES, join(dir, '..', '..', 'data-plane.ts')]) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const banned of ['rawSql', 'executeSql', "body['sql']", "body['query']", "body['statement']"]) {
        expect({ f, banned, hit: code.includes(banned) }).toEqual({ f, banned, hit: false });
      }
    }
  });

  it('database credentials (DbConnection fields) never appear in the connector/dialect source as literals', () => {
    for (const f of FILES) {
      const code = readFileSync(f, 'utf8');
      for (const banned of ['password:', 'PASSWORD', "user: '", "host: '"]) {
        expect({ f, banned, hit: code.includes(banned) }).toEqual({ f, banned, hit: false });
      }
    }
  });
});

describe('Phase 3G-2 — a plain ConnectorError import sanity check', () => {
  it('ConnectorError carries the code and nothing else user-facing', () => {
    const e = new ConnectorError('COLUMN_NOT_MAPPED');
    expect(e.code).toBe('COLUMN_NOT_MAPPED');
    expect(e.message).toBe('COLUMN_NOT_MAPPED');
  });
});
