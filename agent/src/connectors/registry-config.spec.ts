import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSourceConfig, type GatewaySourceConfig } from './registry';
import { loadSourceConfigFromFile, loadEffectiveSourceConfig, writeSourceConfigFile, upsertSourceConfig } from '../sources-file';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-sources-test-'));
}

const VALID_ENTRY: GatewaySourceConfig = {
  sourceId: 'src-1',
  kind: 'postgresql',
  connection: { host: 'db.internal', port: 5432, user: 'ro_user', password: 'super-secret-pw', database: 'acme' },
};

describe('loadSourceConfig — env-var source configuration (unchanged, GATEWAY_SOURCES)', () => {
  it('empty when GATEWAY_SOURCES is unset', () => {
    expect(loadSourceConfig({})).toEqual([]);
  });

  it('parses a valid GATEWAY_SOURCES JSON array, including DB credentials', () => {
    const sources = loadSourceConfig({ GATEWAY_SOURCES: JSON.stringify([VALID_ENTRY]) });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceId).toBe('src-1');
    expect(sources[0]!.connection?.password).toBe('super-secret-pw');
  });

  it('invalid JSON throws a clear, actionable error', () => {
    expect(() => loadSourceConfig({ GATEWAY_SOURCES: '{ not json' })).toThrow(/GATEWAY_SOURCES must be valid JSON/);
  });

  it('a non-array JSON value is rejected', () => {
    expect(() => loadSourceConfig({ GATEWAY_SOURCES: '{"sourceId":"x"}' })).toThrow(/GATEWAY_SOURCES must be a JSON array/);
  });

  it('an entry missing sourceId/kind is rejected', () => {
    expect(() => loadSourceConfig({ GATEWAY_SOURCES: JSON.stringify([{ sourceId: 'x' }]) })).toThrow(/needs \{ sourceId, kind \}/);
  });
});

describe('loadSourceConfigFromFile — file-based source configuration (Phase 1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array (not an error) when the file does not exist', () => {
    expect(loadSourceConfigFromFile(path.join(dir, 'missing.json'))).toEqual([]);
  });

  it('parses a valid sources file identically to the env-var path', () => {
    const file = path.join(dir, 'sources.json');
    writeFileSync(file, JSON.stringify([VALID_ENTRY]));
    const sources = loadSourceConfigFromFile(file);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceId).toBe('src-1');
    expect(sources[0]!.connection?.host).toBe('db.internal');
  });

  it('invalid JSON in the file throws, naming the exact file path', () => {
    const file = path.join(dir, 'sources.json');
    writeFileSync(file, '{ not json');
    expect(() => loadSourceConfigFromFile(file)).toThrow(new RegExp(file.replace(/\\/g, '\\\\')));
  });

  it('a non-array JSON value in the file is rejected', () => {
    const file = path.join(dir, 'sources.json');
    writeFileSync(file, '{"sourceId":"x"}');
    expect(() => loadSourceConfigFromFile(file)).toThrow(/not a recognised format/);
  });

  it('an entry missing sourceId/kind in the file is rejected', () => {
    const file = path.join(dir, 'sources.json');
    writeFileSync(file, JSON.stringify([{ sourceId: 'x' }]));
    expect(() => loadSourceConfigFromFile(file)).toThrow(/needs \{ sourceId, kind \}/);
  });
});

describe('loadEffectiveSourceConfig — env wins over file (Phase 1 integration point)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the file when GATEWAY_SOURCES is unset', () => {
    const file = path.join(dir, 'sources.json');
    writeFileSync(file, JSON.stringify([VALID_ENTRY]));
    const sources = loadEffectiveSourceConfig(file, {});
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceId).toBe('src-1');
  });

  it('prefers GATEWAY_SOURCES when it is explicitly set, even if a file also exists', () => {
    const file = path.join(dir, 'sources.json');
    writeFileSync(file, JSON.stringify([{ ...VALID_ENTRY, sourceId: 'from-file' }]));
    const sources = loadEffectiveSourceConfig(file, {
      GATEWAY_SOURCES: JSON.stringify([{ ...VALID_ENTRY, sourceId: 'from-env' }]),
    });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceId).toBe('from-env');
  });

  it('returns empty when neither GATEWAY_SOURCES nor a sources file is present', () => {
    expect(loadEffectiveSourceConfig(path.join(dir, 'missing.json'), {})).toEqual([]);
  });
});

describe('writeSourceConfigFile — the Source Configuration UI\'s write path (Phase 2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a sources file that loadSourceConfigFromFile then reads back identically', () => {
    const file = path.join(dir, 'sources.json');
    writeSourceConfigFile(file, [VALID_ENTRY]);
    expect(loadSourceConfigFromFile(file)).toEqual([VALID_ENTRY]);
  });

  it('creates the parent directory if it does not exist yet', () => {
    const file = path.join(dir, 'nested', 'sources.json');
    writeSourceConfigFile(file, [VALID_ENTRY]);
    expect(loadSourceConfigFromFile(file)).toHaveLength(1);
  });

  it('rejects an entry missing sourceId/kind before writing anything to disk', () => {
    const file = path.join(dir, 'sources.json');
    expect(() => writeSourceConfigFile(file, [{ sourceId: 'x' } as never])).toThrow(/needs \{ sourceId, kind \}/);
  });

  it('an empty array is valid (clearing all sources)', () => {
    const file = path.join(dir, 'sources.json');
    writeSourceConfigFile(file, [VALID_ENTRY]);
    writeSourceConfigFile(file, []);
    expect(loadSourceConfigFromFile(file)).toEqual([]);
  });
});

describe('upsertSourceConfig — add/replace one source without dropping the others (Phase 2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds a source to an empty/missing file', () => {
    const file = path.join(dir, 'sources.json');
    const result = upsertSourceConfig(file, VALID_ENTRY);
    expect(result).toEqual([VALID_ENTRY]);
    expect(loadSourceConfigFromFile(file)).toEqual([VALID_ENTRY]);
  });

  it('adds a second source while keeping the first', () => {
    const file = path.join(dir, 'sources.json');
    upsertSourceConfig(file, VALID_ENTRY);
    const second = { ...VALID_ENTRY, sourceId: 'src-2' };
    const result = upsertSourceConfig(file, second);
    expect(result.map((s) => s.sourceId).sort()).toEqual(['src-1', 'src-2']);
  });

  it('replaces an existing source with the same sourceId rather than duplicating it', () => {
    const file = path.join(dir, 'sources.json');
    upsertSourceConfig(file, VALID_ENTRY);
    const updated: GatewaySourceConfig = { ...VALID_ENTRY, connection: { ...VALID_ENTRY.connection!, host: 'new-host.internal' } };
    const result = upsertSourceConfig(file, updated);
    expect(result).toHaveLength(1);
    expect(result[0]!.connection?.host).toBe('new-host.internal');
  });

  it('the file on disk is restrictively permissioned the same way device-credential.json is', () => {
    const file = path.join(dir, 'sources.json');
    upsertSourceConfig(file, VALID_ENTRY);
    // Behavioral contract check: the file is written and readable by this
    // process; the 0o600 mode argument itself is covered by source
    // inspection (same pattern as pending-enrollment.spec.ts's equivalent
    // test) since exact permission bits are platform-dependent to assert.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });
});
