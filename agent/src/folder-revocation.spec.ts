import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectorRegistry, type GatewaySourceConfig } from './connectors/registry';
import { StorageRegistry } from './storage/registry';
import { RevokedFolders } from './revoked-folders';
import { applyRevocations, loadSourceConfigFromFile, writeSourceConfigFile } from './sources-file';
import { applyFolderRevocations } from './startup-tasks';

/**
 * "Remove folder" arriving at the Gateway.
 *
 * Two halves, and both matter: the LOCAL FILE must stop naming the folder (so
 * the removal survives a restart) and the RUNNING PROCESS must stop serving it
 * (so the removal does not wait for one). Neither half may ever take away a
 * grant that was not revoked, or an entry the operator configured by hand.
 */

function stateDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-revocation-test-'));
}

const READ: GatewaySourceConfig = { sourceId: 'src-read', kind: 'filesystem', roots: ['C:\\A'], access: 'read' };
const WRITE: GatewaySourceConfig = { sourceId: 'root-write', kind: 'filesystem', roots: ['C:\\B'], access: 'write', storageRootId: 'root-write' };
const BOTH: GatewaySourceConfig = { sourceId: 'src-both', kind: 'filesystem', roots: ['C:\\C'], access: 'both', storageRootId: 'root-both' };
/** An entry an operator wrote by hand, long before any of this existed. */
const LEGACY: GatewaySourceConfig = { sourceId: 'hand-configured', kind: 'csv', roots: ['C:\\D'] };

function fileWith(...sources: GatewaySourceConfig[]): string {
  const file = path.join(stateDir(), 'sources.json');
  writeSourceConfigFile(file, sources, null);
  return file;
}

describe('applying revocations to the local source list', () => {
  it('removes a read-only folder outright', () => {
    const file = fileWith(READ, LEGACY);
    expect(applyRevocations(file, { sourceIds: ['src-read'], storageRootIds: [] }, null)).toBe(1);
    expect(loadSourceConfigFromFile(file).map((s) => s.sourceId)).toEqual(['hand-configured']);
  });

  it('removes a write-only folder, which is keyed by its storage location id', () => {
    const file = fileWith(WRITE);
    expect(applyRevocations(file, { sourceIds: [], storageRootIds: ['root-write'] }, null)).toBe(1);
    expect(loadSourceConfigFromFile(file)).toEqual([]);
  });

  it('removes a read+write folder when both grants are revoked', () => {
    const file = fileWith(BOTH);
    applyRevocations(file, { sourceIds: ['src-both'], storageRootIds: ['root-both'] }, null);
    expect(loadSourceConfigFromFile(file)).toEqual([]);
  });

  it('DOWNGRADES rather than deletes when only one grant of a read+write folder is revoked', () => {
    const file = fileWith(BOTH);
    applyRevocations(file, { sourceIds: [], storageRootIds: ['root-both'] }, null);
    const [entry] = loadSourceConfigFromFile(file);
    // Losing write must not cost the administrator their read grant.
    expect(entry).toMatchObject({ sourceId: 'src-both', access: 'read' });
    expect(entry!.storageRootId).toBeUndefined();

    const file2 = fileWith(BOTH);
    applyRevocations(file2, { sourceIds: ['src-both'], storageRootIds: [] }, null);
    expect(loadSourceConfigFromFile(file2)[0]).toMatchObject({ access: 'write', storageRootId: 'root-both' });
  });

  it('never touches an entry nobody revoked — including one an operator configured by hand', () => {
    const file = fileWith(READ, WRITE, BOTH, LEGACY);
    applyRevocations(file, { sourceIds: ['src-read'], storageRootIds: [] }, null);
    expect(loadSourceConfigFromFile(file).map((s) => s.sourceId).sort()).toEqual([
      'hand-configured',
      'root-write',
      'src-both',
    ]);
  });

  it('is idempotent, and does not rewrite the file when there is nothing to do', () => {
    const file = fileWith(READ, LEGACY);
    expect(applyRevocations(file, { sourceIds: ['src-read'], storageRootIds: [] }, null)).toBe(1);
    expect(applyRevocations(file, { sourceIds: ['src-read'], storageRootIds: [] }, null)).toBe(0);
    expect(applyRevocations(file, { sourceIds: [], storageRootIds: [] }, null)).toBe(0);
    expect(loadSourceConfigFromFile(file).map((s) => s.sourceId)).toEqual(['hand-configured']);
  });
});

describe('a revocation takes effect in the RUNNING process, not at the next restart', () => {
  it('a revoked folder stops being readable, although the local list still names it', () => {
    const revoked = new RevokedFolders();
    const registry = new ConnectorRegistry([READ], undefined, revoked);
    expect(() => registry.get('src-read')).not.toThrow();

    revoked.add('src-read');

    expect(() => registry.get('src-read')).toThrow('SOURCE_NOT_AUTHORIZED');
  });

  it('a revoked folder stops being writable, and is no longer offered when claiming work', () => {
    const revoked = new RevokedFolders();
    const registry = new StorageRegistry([{ storageRootId: 'root-write', rootPath: 'C:\\B' }], revoked);
    expect(registry.ids()).toEqual(['root-write']);

    revoked.add('root-write');

    expect(() => registry.get('root-write')).toThrow('STORAGE_ROOT_NOT_AUTHORIZED');
    // DPDP is told this Gateway can no longer deliver there, so it stops
    // handing it work it would have to refuse.
    expect(registry.ids()).toEqual([]);
  });

  it('the revocation set can only ever deny: there is no way to put an id back', () => {
    const revoked = new RevokedFolders();
    revoked.add('a', 'b', 'a');
    expect(revoked.size).toBe(2);
    expect(Object.keys(revoked)).not.toContain('remove');
    expect((revoked as unknown as Record<string, unknown>)['delete']).toBeUndefined();
  });

  it('other folders keep working after one is revoked', () => {
    const revoked = new RevokedFolders();
    const registry = new ConnectorRegistry([READ, BOTH], undefined, revoked);
    revoked.add('src-read');
    expect(() => registry.get('src-read')).toThrow();
    expect(() => registry.get('src-both')).not.toThrow();
  });
});

describe('fetching revocations from DPDP', () => {
  const log = () => undefined;

  it('applies what DPDP reports', async () => {
    const file = fileWith(READ, LEGACY);
    const client = {
      listFolderRevocations: jest.fn().mockResolvedValue({ revokedSourceIds: ['src-read'], revokedStorageRootIds: [] }),
    };

    const res = await applyFolderRevocations({ sourcesFilePath: file, protector: null, client: client as never, deviceToken: 't', log });

    expect(res.applied).toBe(1);
    expect(loadSourceConfigFromFile(file).map((s) => s.sourceId)).toEqual(['hand-configured']);
  });

  it('changes NOTHING when DPDP cannot be reached — the list is never cleared on a failure', async () => {
    const file = fileWith(READ, WRITE);
    const client = { listFolderRevocations: jest.fn().mockRejectedValue(new Error('offline')) };

    const res = await applyFolderRevocations({ sourcesFilePath: file, protector: null, client: client as never, deviceToken: 't', log });

    expect(res.applied).toBe(0);
    expect(loadSourceConfigFromFile(file)).toHaveLength(2);
  });

  it('does nothing at all when this Gateway is not paired', async () => {
    const file = fileWith(READ);
    const res = await applyFolderRevocations({ sourcesFilePath: file, protector: null, client: null, deviceToken: null, log });
    expect(res.applied).toBe(0);
    expect(loadSourceConfigFromFile(file)).toHaveLength(1);
  });
});
