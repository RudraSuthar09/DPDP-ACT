import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GatewaySourceConfig } from './connectors/registry';
import {
  CONNECTION_SECRET_FIELDS,
  PENDING_SOURCES_FILE_NAME,
  SOURCES_FORMAT,
  SourcesFileError,
  appendPendingSource,
  applyPendingSources,
  createDpapiSecretProtector,
  loadEffectiveSourceConfig,
  migrateLegacySourcesFile,
  readSourcesFile,
  writeSourcesFile,
  type SecretProtector,
} from './sources-file';
import type { DbConnection } from './connectors/db/db-client';
import { DpapiError } from './dpapi';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-sources-v2-'));
}

const PG: GatewaySourceConfig = {
  sourceId: 'crm',
  kind: 'postgresql',
  identityColumn: 'email',
  connection: { host: 'db.internal', port: 5432, user: 'ro_user', password: 'ro-PASSWORD-1', database: 'crm' },
  writeConnection: { host: 'db.internal', port: 5432, user: 'rw_user', password: 'rw-PASSWORD-2', database: 'crm' },
};
const CSV: GatewaySourceConfig = { sourceId: 'exports', kind: 'csv', roots: ['D:\\Exports'] };

/** MOCKED protector — reversible hex, plus a per-instance "identity" baked
 *  into the ciphertext so a blob protected by one identity fails to
 *  unprotect under another, exactly like DPAPI CurrentUser scope. */
function fakeProtector(identity = 'svc'): SecretProtector {
  return {
    scheme: 'dpapi-user',
    protect: (p) => Buffer.from(`${identity}|${p}`, 'utf8').toString('hex'),
    unprotect: (c) => {
      const [who, ...rest] = Buffer.from(c, 'hex').toString('utf8').split('|');
      if (who !== identity) throw new DpapiError('wrong identity');
      return rest.join('|');
    },
  };
}

describe('sources.json v2 — DPAPI-protected credentials (MOCKED protector)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = freshDir();
    file = path.join(dir, 'sources.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips every field, including both credentials', () => {
    writeSourcesFile(file, [PG, CSV], fakeProtector());
    expect(readSourcesFile(file, fakeProtector())).toEqual({ sources: [PG, CSV], storage: 'protected' });
  });

  it('the file on disk never contains a password, but keeps non-secret fields readable', () => {
    writeSourcesFile(file, [PG], fakeProtector());
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('ro-PASSWORD-1');
    expect(raw).not.toContain('rw-PASSWORD-2');
    const disk = JSON.parse(raw);
    expect(disk).toMatchObject({ format: SOURCES_FORMAT, version: 2 });
    expect(disk.sources[0].connection).toMatchObject({ host: 'db.internal', user: 'ro_user', database: 'crm' });
    expect(disk.sources[0].connection.password).toBeUndefined();
    expect(disk.sources[0].connection.secrets.password).toMatchObject({ scheme: 'dpapi-user', v: 1 });
    expect(disk.sources[0].roots).toBeUndefined();
  });

  it('every declared secret field is stored encrypted, and nothing secret-looking is left in clear', () => {
    writeSourcesFile(file, [PG], fakeProtector());
    const conn = JSON.parse(readFileSync(file, 'utf8')).sources[0].connection;
    for (const field of CONNECTION_SECRET_FIELDS) {
      expect(conn[field]).toBeUndefined();
      expect(conn.secrets[field]).toBeDefined();
    }
    for (const key of Object.keys(conn)) {
      expect(key).not.toMatch(/pass|secret(?!s$)|token|key/i);
    }
  });

  it('an empty password is not wrapped in an envelope, and round-trips as empty', () => {
    const noPw: GatewaySourceConfig = { sourceId: 'db2', kind: 'mysql', connection: { host: 'h', port: 3306, user: 'u', password: '', database: 'd' } };
    writeSourcesFile(file, [noPw], fakeProtector());
    expect(JSON.parse(readFileSync(file, 'utf8')).sources[0].connection.secrets).toEqual({});
    expect((readSourcesFile(file, fakeProtector()).sources[0]!.connection as DbConnection).password).toBe('');
  });

  it('SERVICE-IDENTITY ASSUMPTION: a file protected by one identity is UNDECRYPTABLE by another, and is left untouched', () => {
    writeSourcesFile(file, [PG], fakeProtector('service-account'));
    const before = readFileSync(file, 'utf8');
    try {
      readSourcesFile(file, fakeProtector('elevated-admin'));
      throw new Error('expected UNDECRYPTABLE');
    } catch (err) {
      expect(err).toBeInstanceOf(SourcesFileError);
      expect((err as SourcesFileError).code).toBe('UNDECRYPTABLE');
      expect((err as Error).message).toContain('crm');
      expect((err as Error).message).not.toContain('ro-PASSWORD-1');
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('a protected file on a platform without a protector reports PROTECTION_UNAVAILABLE (does not pretend)', () => {
    writeSourcesFile(file, [PG], fakeProtector());
    expect(() => readSourcesFile(file, null)).toThrow(expect.objectContaining({ code: 'PROTECTION_UNAVAILABLE' }));
  });

  it('a newer file version is rejected as UNSUPPORTED_VERSION and left unchanged', () => {
    writeFileSync(file, JSON.stringify({ format: SOURCES_FORMAT, version: 3, sources: [] }));
    expect(() => readSourcesFile(file, fakeProtector())).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }));
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(3);
  });

  it('an unknown secret envelope version or scheme is UNSUPPORTED_VERSION', () => {
    writeSourcesFile(file, [PG], fakeProtector());
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    disk.sources[0].connection.secrets.password.v = 2;
    writeFileSync(file, JSON.stringify(disk));
    expect(() => readSourcesFile(file, fakeProtector())).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }));
    disk.sources[0].connection.secrets.password.v = 1;
    disk.sources[0].connection.secrets.password.scheme = 'aes-local';
    writeFileSync(file, JSON.stringify(disk));
    expect(() => readSourcesFile(file, fakeProtector())).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }));
  });

  it.each([
    ['not JSON', '{nope'],
    ['an unknown object shape', JSON.stringify({ hello: 'world' })],
    ['a v2 file without a sources list', JSON.stringify({ format: SOURCES_FORMAT, version: 2 })],
    ['a v2 entry without sourceId', JSON.stringify({ format: SOURCES_FORMAT, version: 2, sources: [{ kind: 'csv' }] })],
    [
      'a clear-text password inside a protected file',
      JSON.stringify({ format: SOURCES_FORMAT, version: 2, sources: [{ sourceId: 'a', kind: 'mysql', connection: { host: 'h', password: 'x' } }] }),
    ],
    [
      'an unknown secret field',
      JSON.stringify({ format: SOURCES_FORMAT, version: 2, sources: [{ sourceId: 'a', kind: 'mysql', connection: { secrets: { apiKey: { scheme: 'dpapi-user', v: 1, data: '00' } } } }] }),
    ],
  ])('%s is reported as CORRUPT without echoing file contents', (_label, content) => {
    writeFileSync(file, content);
    try {
      readSourcesFile(file, fakeProtector());
      throw new Error('expected CORRUPT');
    } catch (err) {
      expect((err as SourcesFileError).code).toBe('CORRUPT');
      expect((err as Error).message).not.toMatch(/"x"|hello|world/);
    }
  });

  it('writes atomically: no temp files are left behind after repeated writes', () => {
    writeSourcesFile(file, [PG], fakeProtector());
    writeSourcesFile(file, [PG, CSV], fakeProtector());
    expect(readdirSync(dir)).toEqual(['sources.json']);
  });

  it('a validation failure writes nothing (existing file preserved)', () => {
    writeSourcesFile(file, [PG], fakeProtector());
    const before = readFileSync(file, 'utf8');
    expect(() => writeSourcesFile(file, [{ sourceId: 'x' } as unknown as GatewaySourceConfig], fakeProtector())).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('legacy v1 (plaintext array) compatibility and migration (MOCKED protector)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = freshDir();
    file = path.join(dir, 'sources.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a legacy file and reports it as legacy-plaintext', () => {
    writeFileSync(file, JSON.stringify([PG, CSV]));
    expect(readSourcesFile(file, fakeProtector())).toEqual({ sources: [PG, CSV], storage: 'legacy-plaintext' });
  });

  it('migrates a legacy file in place: same sources, no plaintext left, no backup kept', () => {
    writeFileSync(file, JSON.stringify([PG, CSV]));
    expect(migrateLegacySourcesFile(file, fakeProtector())).toBe(2);
    expect(readFileSync(file, 'utf8')).not.toContain('ro-PASSWORD-1');
    expect(readdirSync(dir)).toEqual(['sources.json']);
    expect(readSourcesFile(file, fakeProtector())).toEqual({ sources: [PG, CSV], storage: 'protected' });
  });

  it('migration is idempotent: an already-protected file is left alone (returns 0)', () => {
    writeSourcesFile(file, [PG], fakeProtector());
    const before = readFileSync(file, 'utf8');
    expect(migrateLegacySourcesFile(file, fakeProtector())).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('no file at all: nothing to migrate, empty list', () => {
    expect(migrateLegacySourcesFile(file, fakeProtector())).toBe(0);
    expect(readSourcesFile(file, fakeProtector())).toEqual({ sources: [], storage: 'none' });
  });

  it('without a protector (non-Windows dev), writes stay legacy plaintext — honestly, not pretend-encrypted', () => {
    writeSourcesFile(file, [PG], null);
    expect(Array.isArray(JSON.parse(readFileSync(file, 'utf8')))).toBe(true);
  });

  it('GATEWAY_SOURCES still wins over the file', () => {
    writeSourcesFile(file, [PG], fakeProtector());
    const env = { GATEWAY_SOURCES: JSON.stringify([CSV]) };
    expect(loadEffectiveSourceConfig(file, env, fakeProtector())).toEqual([CSV]);
  });
});

describe('pending-sources.json hand-off (elevated helper -> service) (MOCKED protector)', () => {
  let dir: string;
  beforeEach(() => (dir = freshDir()));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the service merges queued entries, encrypts them, and scrubs + deletes the pending file', () => {
    writeSourcesFile(path.join(dir, 'sources.json'), [CSV], fakeProtector());
    appendPendingSource(dir, PG);
    expect(applyPendingSources(dir, fakeProtector())).toBe(1);
    expect(existsSync(path.join(dir, PENDING_SOURCES_FILE_NAME))).toBe(false);
    const raw = readFileSync(path.join(dir, 'sources.json'), 'utf8');
    expect(raw).not.toContain('ro-PASSWORD-1');
    expect(readSourcesFile(path.join(dir, 'sources.json'), fakeProtector()).sources).toEqual([CSV, PG]);
  });

  it('a queued entry with an existing sourceId replaces it', () => {
    writeSourcesFile(path.join(dir, 'sources.json'), [PG], fakeProtector());
    appendPendingSource(dir, { ...PG, connection: { ...PG.connection!, host: 'new-host' } });
    applyPendingSources(dir, fakeProtector());
    const sources = readSourcesFile(path.join(dir, 'sources.json'), fakeProtector()).sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]!.connection?.host).toBe('new-host');
  });

  it('if sources.json cannot be decrypted, the pending file is KEPT (nothing is lost) and the error surfaces', () => {
    writeSourcesFile(path.join(dir, 'sources.json'), [PG], fakeProtector('old-identity'));
    const before = readFileSync(path.join(dir, 'sources.json'), 'utf8');
    appendPendingSource(dir, CSV);
    expect(() => applyPendingSources(dir, fakeProtector('new-identity'))).toThrow(expect.objectContaining({ code: 'UNDECRYPTABLE' }));
    expect(readFileSync(path.join(dir, 'sources.json'), 'utf8')).toBe(before);
    expect(existsSync(path.join(dir, PENDING_SOURCES_FILE_NAME))).toBe(true);
  });

  it('nothing pending: no-op', () => {
    expect(applyPendingSources(dir, fakeProtector())).toBe(0);
  });

  it('a corrupt pending file is reported, not silently dropped', () => {
    writeFileSync(path.join(dir, PENDING_SOURCES_FILE_NAME), '{bad');
    expect(() => applyPendingSources(dir, fakeProtector())).toThrow(expect.objectContaining({ code: 'CORRUPT' }));
    expect(existsSync(path.join(dir, PENDING_SOURCES_FILE_NAME))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REAL Windows DPAPI — powershell.exe, CryptProtectData under THIS test
// process's account (not the service account; that needs an admin-installed
// service — see gateway-installer/README.md's acceptance checklist).
// ---------------------------------------------------------------------------
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('sources.json v2 with REAL Windows DPAPI (no mocks)', () => {
  let dir: string;
  beforeEach(() => (dir = freshDir()));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('migrates a legacy file and reads it back across a fresh protector instance (restart persistence)', () => {
    const file = path.join(dir, 'sources.json');
    const nonAscii: GatewaySourceConfig = { ...PG, connection: { ...PG.connection!, password: 'pässwörd-日本-"quote\'s' } };
    writeFileSync(file, JSON.stringify([nonAscii]));
    expect(migrateLegacySourcesFile(file, createDpapiSecretProtector())).toBe(1);
    expect(readFileSync(file, 'utf8')).not.toContain('pässwörd');
    // A brand-new protector models a service restart: nothing in memory survives.
    expect(readSourcesFile(file, createDpapiSecretProtector()).sources).toEqual([nonAscii]);
  }, 180_000);
});
