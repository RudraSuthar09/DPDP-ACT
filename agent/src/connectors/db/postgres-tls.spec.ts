/**
 * PostgreSQL TLS verification.
 *
 *   UNIT         postgresTlsOptions / config parsing / source-tls resolution.
 *   GUARD        static check that db-client.ts cannot disable verification.
 *   INTEGRATION  the REAL `pg` driver (realDbClientFactory) and REAL Node TLS
 *                against a LOCAL SIMULATED PostgreSQL server
 *                (__fixtures__/mock-postgres.ts) using TEST-ONLY certificates.
 *                Not a real PostgreSQL server; no real database was available.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realDbClientFactory, postgresTlsOptions, type DbConnection } from './db-client';
import { DatabaseConnector } from './database-connector';
import { dialectFor } from './dialect';
import { parseSourceConfigEntries } from '../registry';
import { resolveSourceTls } from '../../source-tls';
import { readSourcesFile, writeSourcesFile } from '../../sources-file';
import { startMockPostgres, type MockPostgres } from '../../__fixtures__/mock-postgres';

const TLS_DIR = path.join(__dirname, '..', '..', '__fixtures__', 'tls');
const TEST_CA = readFileSync(path.join(TLS_DIR, 'test-ca.pem'), 'utf8');
const PASSWORD = 'Db-Pa55-never-leaks';

function conn(port: number, extra: Partial<DbConnection> = {}): DbConnection {
  return { host: 'localhost', port, user: 'reader', password: PASSWORD, database: 'app', ...extra };
}

async function selectOne(c: DbConnection): Promise<unknown> {
  const client = realDbClientFactory('postgresql', c);
  try {
    return await client.query('SELECT 1 AS ok', [], { timeoutMs: 10_000 });
  } finally {
    await client.close();
  }
}

async function failureOf(c: DbConnection): Promise<Error & { code?: string }> {
  try {
    await selectOne(c);
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error('expected the connection to fail');
}

describe('UNIT postgresTlsOptions', () => {
  it('ssl off -> plaintext (undefined); ssl on -> verifying options; a CA is passed through', () => {
    expect(postgresTlsOptions(conn(1))).toBeUndefined();
    expect(postgresTlsOptions(conn(1, { ssl: false }))).toBeUndefined();
    expect(postgresTlsOptions(conn(1, { ssl: true }))).toEqual({});
    expect(postgresTlsOptions(conn(1, { ssl: true, sslCa: ['PEM'] }))).toEqual({ ca: ['PEM'] });
  });

  it('never produces an option that relaxes verification', () => {
    for (const o of [postgresTlsOptions(conn(1, { ssl: true })), postgresTlsOptions(conn(1, { ssl: true, sslCa: ['x'] }))]) {
      expect(Object.keys(o ?? {})).toEqual(expect.not.arrayContaining(['rejectUnauthorized', 'checkServerIdentity', 'servername']));
    }
  });
});

describe('GUARD db-client.ts', () => {
  it('contains no rejectUnauthorized / checkServerIdentity override for any driver', () => {
    const src = readFileSync(path.join(__dirname, 'db-client.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(src).not.toContain('rejectUnauthorized');
    expect(src).not.toContain('checkServerIdentity');
  });
});

describe('UNIT source configuration', () => {
  it('accepts sslCaFile with ssl:true and keeps it through parsing', () => {
    const [s] = parseSourceConfigEntries(
      [{ sourceId: 'pg', kind: 'postgresql', connection: { host: 'h', port: 5432, user: 'u', password: 'p', database: 'd', ssl: true, sslCaFile: 'pg-ca.pem' } }],
      'test',
    );
    expect(s!.connection).toMatchObject({ ssl: true, sslCaFile: 'pg-ca.pem' });
  });

  it('rejects sslCaFile without ssl:true, and an empty sslCaFile', () => {
    const bad = (connection: object) => () => parseSourceConfigEntries([{ sourceId: 'pg', kind: 'postgresql', connection }], 'test');
    expect(bad({ host: 'h', port: 1, sslCaFile: 'x.pem' })).toThrow(/requires "ssl": true/);
    expect(bad({ host: 'h', port: 1, ssl: false, sslCaFile: 'x.pem' })).toThrow(/requires "ssl": true/);
    expect(bad({ host: 'h', port: 1, ssl: true, sslCaFile: '  ' })).toThrow(/non-empty/);
  });

  it('ssl and sslCaFile survive the protected sources.json (v2) round trip; only the password is encrypted (MOCK protector)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dpdp-pgsrc-'));
    try {
      const file = path.join(dir, 'sources.json');
      const protector = { scheme: 'mock', protect: (p: string) => Buffer.from(p).toString('hex'), unprotect: (d: string) => Buffer.from(d, 'hex').toString() };
      const src = { sourceId: 'pg', kind: 'postgresql' as const, connection: { host: 'db.corp', port: 5432, user: 'u', password: PASSWORD, database: 'd', ssl: true, sslCaFile: 'pg-ca.pem' } };
      writeSourcesFile(file, [src], protector);
      const raw = readFileSync(file, 'utf8');
      expect(raw).not.toContain(PASSWORD);
      expect(raw).toContain('"sslCaFile": "pg-ca.pem"');
      expect(readSourcesFile(file, protector).sources[0]!.connection).toEqual(src.connection);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never accepts runtime-only sslCa from configuration', () => {
    const [s] = parseSourceConfigEntries([{ sourceId: 'pg', kind: 'postgresql', connection: { host: 'h', port: 1, ssl: true, sslCa: ['EVIL-CA'] } }], 'test');
    expect(s!.connection!.sslCa).toBeUndefined();
  });
});

describe('UNIT resolveSourceTls (CA file location and content rules)', () => {
  let root: string;
  let cfg: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dpdp-pgca-'));
    mkdirSync(path.join(root, 'config'));
    cfg = path.join(root, 'config', 'config.json');
    copyFileSync(path.join(TLS_DIR, 'test-ca.pem'), path.join(root, 'config', 'pg-ca.pem'));
    copyFileSync(path.join(TLS_DIR, 'test-ca.pem'), path.join(root, 'outside.pem'));
    copyFileSync(path.join(TLS_DIR, 'localhost.pem'), path.join(root, 'config', 'leaf.pem'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const source = (sslCaFile: string, extra: object = {}) => ({
    sourceId: 'pg',
    kind: 'postgresql' as const,
    connection: { host: 'h', port: 5432, user: 'u', password: PASSWORD, database: 'd', ssl: true, sslCaFile },
    ...extra,
  });

  it('loads the CA for the read and the write connection', () => {
    const r = resolveSourceTls([source('pg-ca.pem', { writeConnection: { ...source('pg-ca.pem').connection } })], cfg);
    expect(r.rejected).toBe(0);
    expect(r.sources[0]!.connection!.sslCa).toHaveLength(1);
    expect(r.sources[0]!.writeConnection!.sslCa).toHaveLength(1);
  });

  it('leaves out (fails closed) a source whose CA file is outside the config dir, missing, or not a CA â€” messages carry no password or path', () => {
    const r = resolveSourceTls([source('../outside.pem'), source('missing.pem'), source('leaf.pem'), { sourceId: 'csv', kind: 'csv' as const, roots: ['/x'] }], cfg);
    expect(r.rejected).toBe(3);
    expect(r.sources.map((s) => s.sourceId)).toEqual(['csv']);
    expect(r.messages.join('\n')).toMatch(/inside the Gateway config directory/);
    expect(r.messages.join('\n')).toMatch(/not a CA certificate/);
    expect(r.messages.join('\n')).not.toContain(PASSWORD);
    expect(r.messages.join('\n')).not.toContain(root);
  });

  it('does not mutate its input (sslCa is never written back to sources.json)', () => {
    const input = [source('pg-ca.pem')];
    resolveSourceTls(input, cfg);
    expect(input[0]!.connection).not.toHaveProperty('sslCa');
  });
});

describe('INTEGRATION real pg driver + real TLS against a SIMULATED PostgreSQL server', () => {
  const servers: MockPostgres[] = [];
  const start = async (...args: Parameters<typeof startMockPostgres>) => {
    const s = await startMockPostgres(...args);
    servers.push(s);
    return s;
  };
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  it('trusted certificate via a custom CA (sslCa): connects over TLS and runs the query', async () => {
    const pg = await start({ tls: 'localhost' });
    await expect(selectOne(conn(pg.port, { ssl: true, sslCa: [TEST_CA] }))).resolves.toEqual({ columns: ['ok'], rows: [['1']] });
    expect(pg).toMatchObject({ sslRequests: 1, tlsStartups: 1, plaintextStartups: 0, queries: ['SELECT 1 AS ok'] });
  });

  it('trusted certificate when connecting by IP address (checked against the IP SAN)', async () => {
    const pg = await start({ tls: 'localhost' });
    await expect(selectOne(conn(pg.port, { host: '127.0.0.1', ssl: true, sslCa: [TEST_CA] }))).resolves.toMatchObject({ rows: [['1']] });
  });

  it('untrusted certificate (CA not configured; only public roots trusted) is REJECTED before any startup message', async () => {
    const pg = await start({ tls: 'localhost' });
    const err = await failureOf(conn(pg.port, { ssl: true }));
    expect(err.code).toMatch(/^(SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/);
    expect(pg.tlsStartups + pg.plaintextStartups).toBe(0);
  });

  it('hostname mismatch is REJECTED even though the issuing CA is trusted (DNS name)', async () => {
    const pg = await start({ tls: 'wrong-host' });
    const err = await failureOf(conn(pg.port, { ssl: true, sslCa: [TEST_CA] }));
    expect(err.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(pg.tlsStartups + pg.plaintextStartups).toBe(0);
  });

  it('hostname mismatch is REJECTED when connecting by IP address', async () => {
    const pg = await start({ tls: 'wrong-host' });
    const err = await failureOf(conn(pg.port, { host: '127.0.0.1', ssl: true, sslCa: [TEST_CA] }));
    expect(err.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('a server that refuses TLS: the connection FAILS, never falls back to plaintext', async () => {
    const pg = await start({ refuseTls: true });
    const err = await failureOf(conn(pg.port, { ssl: true, sslCa: [TEST_CA] }));
    expect(err.message).toMatch(/does not support SSL/);
    expect(pg.sslRequests).toBe(1);
    expect(pg.plaintextStartups).toBe(0);
  });

  it('a TLS connection failure (server drops after accepting SSLRequest) fails, with no plaintext retry', async () => {
    const pg = await start({ dropAfterSslRequest: true });
    await failureOf(conn(pg.port, { ssl: true, sslCa: [TEST_CA] }));
    expect(pg.plaintextStartups).toBe(0);
  });

  it('non-TLS configuration (ssl absent) is unchanged: plaintext connection works', async () => {
    const pg = await start({ plaintext: true });
    await expect(selectOne(conn(pg.port))).resolves.toEqual({ columns: ['ok'], rows: [['1']] });
    expect(pg).toMatchObject({ sslRequests: 0, plaintextStartups: 1 });
  });

  it('through the connector, a TLS rejection surfaces only as a sanitized code (no host, no password, no driver text)', async () => {
    const pg = await start({ tls: 'wrong-host' });
    const connector = new DatabaseConnector(dialectFor('postgresql')!, () => realDbClientFactory('postgresql', conn(pg.port, { ssl: true, sslCa: [TEST_CA] })), 10_000);
    let err: (Error & { code?: string }) | undefined;
    try {
      await connector.discover();
    } catch (e) {
      err = e as Error & { code?: string };
    }
    expect(err?.code).toBe('PERMISSION_DENIED');
    expect(`${err?.message} ${JSON.stringify(err)}`).not.toMatch(new RegExp(`${PASSWORD}|wrong\\.example|localhost|${pg.port}`));
  });
});
